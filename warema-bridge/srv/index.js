'use strict';

const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

let shuttingDown = false;
let mqttReady = false;
let stickReady = false;
let systemReady = false;
let weatherInterval = null;
let lastWeatherBroadcast = 0;

/** =========================
 *   ENV / Defaults
 *  ========================= */
const mqttServer = process.env.MQTT_SERVER || 'mqtt://localhost';
const ignoredDevices = process.env.IGNORED_DEVICES ? process.env.IGNORED_DEVICES.split(',') : [];
const forceDevices = process.env.FORCE_DEVICES ? process.env.FORCE_DEVICES.split(',') : [];
const pollingInterval = parseInt(process.env.POLLING_INTERVAL || '30000', 10);
const movingInterval = parseInt(process.env.MOVING_INTERVAL || '1000', 10);

// Weather EMA Aggregation (für Statistik)
const WEATHER_EMA_ALPHA = parseFloat(process.env.WEATHER_EMA_ALPHA || '0.2');
const WEATHER_PUBLISH_INTERVAL_MS = parseInt(process.env.WEATHER_PUBLISH_INTERVAL_MS || '60000', 10);

const settingsPar = {
  wmsChannel: parseInt(process.env.WMS_CHANNEL || '17', 10),
  wmsKey: process.env.WMS_KEY || '00112233445566778899AABBCCDDEEFF',
  wmsPanid: process.env.WMS_PAN_ID || 'FFFF',
  wmsSerialPort: process.env.WMS_SERIAL_PORT || '/dev/ttyUSB0',
};

/** =========================
 *   State
 *  ========================= */
const devices = {};                 // Map von SNR -> { type, position, tilt, lastBrightness }
const rawMessageCache = new Map();  // Cache für Hardware-Rohmeldungen Dedup
const weatherStats = new Map();     // SNR -> { wind, temp, lumen, lastPublish }
const discoveryCache = new Map();   // topic -> payload

// Regen-Hysterese
const rainState = new Map(); // snr -> { state, lastChange }
const RAIN_ON_DELAY  = parseInt(process.env.RAIN_ON_DELAY  || '10000', 10); // ms
const RAIN_OFF_DELAY = parseInt(process.env.RAIN_OFF_DELAY || '30000', 10); // ms

const WAREMA_LED_STEPS = [100,89,78,67,56,45,34,23,12,1];

// LED State Cache für persistente Speicherung der Helligkeit
let ledStateCache = {};

/** =========================
 *   Helpers
 *  ========================= */

// Prüft duplizierte Rohmeldung vom Stick
function isDuplicateRawMessage(stickCmd, snr) {
  const currentTime = Date.now();
  const messageKey = `${snr}_${stickCmd}`;
  const cachedMessage = rawMessageCache.get(messageKey);
  const minTimeDiff = 1000; // 1s Mindestabstand

  if (cachedMessage && (currentTime - cachedMessage.timestamp) < minTimeDiff) {
    return true;
  }

  rawMessageCache.set(messageKey, { timestamp: currentTime });

  // Cleanup (älter als 10s)
  for (const [key, value] of rawMessageCache.entries()) {
    if ((currentTime - value.timestamp) > 10000) {
      rawMessageCache.delete(key);
    }
  }
  return false;
}

/**
 * Normalize Warema brightness value to nearest supported step.
 * @param {number} v - Raw brightness value
 * @returns {number} Nearest supported brightness step
 */
function normalizeWaremaBrightness(v) {
  if (v <= 0) return 0;
  // nächstgelegene bekannte Stufe finden
  let best = WAREMA_LED_STEPS[0];
  let diff = Math.abs(v - best);
  for (const s of WAREMA_LED_STEPS) {
    const d = Math.abs(v - s);
    if (d < diff) {
      diff = d;
      best = s;
    }
  }
  return best;
}

/**
 * Update the exponential moving average (EMA) for weather data.
 * @param {number|null} oldValue - Previous EMA value
 * @param {number} newValue - New measurement
 * @returns {number} Updated EMA value
 */
function updateEMA(oldValue, newValue) {
  if (oldValue === undefined || oldValue === null) return Number(newValue);
  return oldValue + WEATHER_EMA_ALPHA * (Number(newValue) - oldValue);
}

function updateWeatherEMA(snr, data) {
  const now = Date.now();
  let entry = weatherStats.get(snr);
  if (!entry) {
    entry = { wind: null, temp: null, lumen: null, lastPublish: 0 };
    weatherStats.set(snr, entry);
  }

  if (data.wind !== undefined) entry.wind = updateEMA(entry.wind, data.wind);
  if (data.temp !== undefined) entry.temp = updateEMA(entry.temp, data.temp);
  if (data.lumen !== undefined) entry.lumen = updateEMA(entry.lumen, data.lumen);

  if ((now - entry.lastPublish) < WEATHER_PUBLISH_INTERVAL_MS) return;

  if (client?.connected) {
    if (entry.wind !== null)
      client.publish(`warema/${snr}/wind/state`, entry.wind.toFixed(1), { retain: true });
    if (entry.temp !== null)
      client.publish(`warema/${snr}/temperature/state`, entry.temp.toFixed(1), { retain: true });
    if (entry.lumen !== null)
      client.publish(`warema/${snr}/illuminance/state`, Math.round(entry.lumen).toString(), { retain: true });

    entry.lastPublish = now;
    log.debug(`Published EMA weather for ${snr}`);
  }
}

/**
 * Regen-Hysterese (binär, zeitentprellt)
 */
function updateRainState(snr, isRaining) {
  const now = Date.now();

  let entry = rainState.get(snr);
  if (!entry) {
    entry = { state: isRaining, lastChange: now };
    rainState.set(snr, entry);
    // Initialzustand sofort publizieren
    if (client?.connected) {
      client.publish(
        `warema/${snr}/rain/state`,
        isRaining ? 'ON' : 'OFF',
        { retain: true }
      );
    }
    return;
  }

  if (isRaining !== entry.state) {
    const delay = isRaining ? RAIN_ON_DELAY : RAIN_OFF_DELAY;

    if ((now - entry.lastChange) >= delay) {
      entry.state = isRaining;
      entry.lastChange = now;

      if (client && client.connected) {
        client.publish(
          `warema/${snr}/rain/state`,
          entry.state ? 'ON' : 'OFF',
          { retain: true }
        );
      }
    }
  } else {
    // Zustand stabil → Zeitstempel aktualisieren
    entry.lastChange = now;
  }
}


/** =========================
 *   Weather polling
 *  ========================= */
function pollWeatherData() {
  try {
	if (!stickUsb) {
      log.error('stickUsb is undefined during pollWeatherData');
      return;
    }
	
	if (Date.now() - lastWeatherBroadcast < (2 * pollingInterval)) {
      return;
    }
	
    const weatherData = stickUsb.getLastWeatherBroadcast();
    if (weatherData && weatherData.snr) {
      // Gerät registrieren (Sensoren) falls nötig
      if (!devices[weatherData.snr]) {
        registerDevice({ snr: weatherData.snr, type: "63" });
      }
		
      updateWeatherEMA(weatherData.snr, {
        wind: weatherData.wind,
        temp: weatherData.temp,
        lumen: weatherData.lumen
      });
		
      updateRainState(weatherData.snr, weatherData.rain);
    }
  } catch (error) {
    log.error('Error polling weather data: ' + error.toString());
  }
}

/** =========================
 *   Device registration
 *  ========================= */
/**
 * Defensive: always initialize device state before use.
 * @param {object} element - Device descriptor with snr and type
 */
function registerDevice(element) {
  if (!element || !element.snr || !element.type) {
    log.warn('registerDevice called with invalid element:', element);
    return;
  }
  
  const isNew = !devices[element.snr];

  devices[element.snr] = {
    ...devices[element.snr],
    type: element.type
  };
  
  // Defensive: always initialize device state
  devices[element.snr] = { type: element.type };
  log.info('Registering ' + element.snr + ' with type: ' + element.type);

  const availability_topic = 'warema/' + element.snr + '/availability';
  const base_payload = {
    availability: [
      { topic: 'warema/bridge/state' },
      { topic: availability_topic }
    ],
    unique_id: element.snr,
    name: null
  };
  const base_device = {
    identifiers: element.snr,
    manufacturer: "Warema",
    name: element.snr
  };

  let payload;
  let model;
  let topicForDiscovery;

  switch (element.type) {
    case "63": {
      // Weather station pro
      model = 'Weather station pro';
      const payloadBase = {
        ...base_payload,
        device: { ...base_device, model }
      };

      // Illuminance
      const illuminance_payload = {
        ...payloadBase,
        state_topic: `warema/${element.snr}/illuminance/state`,
        device_class: 'illuminance',
        unique_id: `${element.snr}_illuminance`,
        default_entity_id: `sensor.${element.snr}_illuminance`,
        unit_of_measurement: 'lx',
        state_class: 'measurement'
      };
      client.publish(`homeassistant/sensor/${element.snr}/illuminance/config`, JSON.stringify(illuminance_payload), { retain: true });

      // Temperature
      const temperature_payload = {
        ...payloadBase,
        state_topic: `warema/${element.snr}/temperature/state`,
        device_class: 'temperature',
        unique_id: `${element.snr}_temperature`,
        default_entity_id: `sensor.${element.snr}_temperature`,
        unit_of_measurement: '°C',
        state_class: 'measurement',
        suggested_display_precision: 1
      };
      client.publish(`homeassistant/sensor/${element.snr}/temperature/config`, JSON.stringify(temperature_payload), { retain: true });

      // Wind (aggregiert)
      const wind_payload = {
        ...payloadBase,
        state_topic: `warema/${element.snr}/wind/state`,
        device_class: 'wind_speed',
        unique_id: `${element.snr}_wind`,
        default_entity_id: `sensor.${element.snr}_wind`,
        unit_of_measurement: 'm/s',
        state_class: 'measurement',
        suggested_display_precision: 1
      };
      client.publish(`homeassistant/sensor/${element.snr}/wind/config`, JSON.stringify(wind_payload), { retain: true });

      // Rain
      const rain_payload = {
        ...payloadBase,
        state_topic: `warema/${element.snr}/rain/state`,
        device_class: 'moisture',
        unique_id: `${element.snr}_rain`,
        default_entity_id: `binary_sensor.${element.snr}_rain`,
        payload_on: 'ON',
        payload_off: 'OFF'
      };
      client.publish(`homeassistant/binary_sensor/${element.snr}/rain/config`, JSON.stringify(rain_payload), { retain: true });

      if (client && client.connected) {
        client.publish(availability_topic, 'online', { retain: true });
      }
      devices[element.snr] = { type: element.type }; // Sensorgerät im Cache
      log.info('No need to add to stick, weather updates are broadcasted. ' + element.snr + ' with type: ' + element.type);
      return;
    }

    case "07": // WMS Remote pro
    case "09": // WMS WebControl Pro
      return;

    case "20": { // Plug receiver (als Cover, Lamellendach)
      model = 'Plug receiver';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        position_open: 100, // Homeassistant: 100 = offen
        position_closed: 0, // Homeassistant: 0 = geschlossen
        command_topic: `warema/${element.snr}/set`,
        state_topic: `warema/${element.snr}/state`,
        position_topic: `warema/${element.snr}/position`,
        set_position_topic: `warema/${element.snr}/set_position`
      };
      topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;
      break;
    }

    case "21": { // Actuator UP (als Cover)
      model = 'Actuator UP';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${element.snr}/set`,
        position_topic: `warema/${element.snr}/position`,
        tilt_status_topic: `warema/${element.snr}/tilt`,
        set_position_topic: `warema/${element.snr}/set_position`,
        tilt_command_topic: `warema/${element.snr}/set_tilt`,
        tilt_closed_value: -100,
        tilt_opened_value: 100,
        tilt_min: -100,
        tilt_max: 100
      };
      topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;
      break;
    }

    case "24": { // Smart socket
      model = 'Smart socket';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        state_topic: `warema/${element.snr}/state`,
        command_topic: `warema/${element.snr}/set`,
      };
      topicForDiscovery = `homeassistant/switch/${element.snr}/${element.snr}/config`;
      break;
    }

    case "25": { // Vertical awning
      model = 'Vertical awning';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${element.snr}/set`,
        position_topic: `warema/${element.snr}/position`,
        set_position_topic: `warema/${element.snr}/set_position`,
      };
      topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;
      break;
    }

    case "28": { // LED -> MQTT Light mit Dimmfunktion
      model = 'LED';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        name: `LED ${element.snr}`,
        command_topic: `warema/${element.snr}/light/set`,
        state_topic: `warema/${element.snr}/light/state`,
        brightness_command_topic: `warema/${element.snr}/light/set_brightness`,
        brightness_state_topic: `warema/${element.snr}/light/brightness`,
        brightness_scale: 100,
        supported_color_modes: ["brightness"],
        payload_on: 'ON',
        payload_off: 'OFF',
        unique_id: `${element.snr}_light`,
        default_entity_id: `light.${element.snr}`
      };
      topicForDiscovery = `homeassistant/light/${element.snr}/${element.snr}/config`;
      break;
    }

    default:
      log.warn('Unrecognized device type: ' + element.type);
      return;
  }

  if (ignoredDevices.includes(element.snr.toString())) {
    log.info('Ignoring and removing device ' + element.snr + ' (type ' + element.type + ')');
    return;
  }

  log.debug('Adding device ' + element.snr + ' (type ' + element.type + ')');

  // Für steuerbare Geräte auf den Stick legen
  if (isNew && element.type !== "63") {
    stickUsb.vnBlindAdd(parseInt(element.snr, 10), element.snr.toString());
  }
  devices[element.snr] = { type: element.type };

  // Availability online setzen
  if (client?.connected) {
    client.publish(availability_topic, 'online', { retain: true });
	// Falls LED nach MQTT-Connect registriert wird
    restoreLedState(element.snr);
  }

  // Discovery publizieren
  discoveryCache.set(topicForDiscovery, payload);

  if (client?.connected) {
    client.publish(topicForDiscovery, JSON.stringify(payload), { retain: true });
  }
}

function initStick() {
  log.info('Initializing WMS stick...');

  stickUsb.setPosUpdInterval(pollingInterval);
  stickUsb.setWatchMovingBlindsInterval(movingInterval);

  // Explizit scannen
  stickUsb.scanDevices({ autoAssignBlinds: false });
}

function rebindAfterMqttConnect() {
  if (!mqttReady || shuttingDown) return;

  log.info('Rebinding MQTT state (discovery + availability + state)');

  // 1️ Discovery erneut veröffentlichen
  for (const [topic, payload] of discoveryCache.entries()) {
    client.publish(topic, JSON.stringify(payload), { retain: true });
  }

  // 2️ Bridge Availability
  client.publish('warema/bridge/state', 'online', { retain: true });

  // 3️ Geräte Availability
  for (const snr of Object.keys(devices)) {
    client.publish(`warema/${snr}/availability`, 'online', { retain: true });
  }

  // 4️ States aktiv neu synchronisieren
  syncAllDeviceStates();
}

function trySystemReady() {
  if (mqttReady && stickReady && !systemReady) {
    systemReady = true;
    log.info('System fully ready (MQTT + Stick). Performing initial rebind.');
    rebindAfterMqttConnect();
  }
}

/** =========================
 *   Stick Callback
 *  ========================= */
function callback(err, msg) {
  if (err) {
    log.error(err && err.stack ? err.stack : err);
  }
  if (!msg) return;

  log.debug('Callback received topic: ' + msg.topic);

  switch (msg.topic) {
    case 'wms-vb-init-completion':
      log.info('Warema stick ready');
      stickReady = true;
      initStick();
	  trySystemReady();
      break;

    case 'wms-vb-scanned-devices':
      log.debug('Scanned devices:\n' + JSON.stringify(msg.payload, null, 2));
      if (forceDevices && forceDevices.length) {
        forceDevices.forEach(deviceString => {
          const [snr, type] = deviceString.split(':');
          registerDevice({ snr: snr, type: type || "25" });
        });
      } else {
        msg.payload.devices.forEach(element => registerDevice(element));
      }
      log.debug('Registered devices:\n' + JSON.stringify(stickUsb.vnBlindsList(), null, 2));
      break;

    case 'wms-vb-rcv-weather-broadcast': {
      log.silly('Weather broadcast:\n' + JSON.stringify(msg.payload, null, 2));
	  lastWeatherBroadcast = Date.now();
      const stickCmd = msg.payload.stickCmd || '';
      const w = msg.payload.weather;

      if (isDuplicateRawMessage(stickCmd, w.snr)) {
        log.debug('Skipping duplicate raw hardware message for device: ' + w.snr);
        break;
      }

      if (!devices[w.snr]) {
        registerDevice({ snr: w.snr, type: "63" });
      }

      updateWeatherEMA(w.snr, {
        wind: w.wind,
        temp: w.temp,
        lumen: w.lumen
      });

      updateRainState(w.snr, w.rain);
      break;
    }

    case 'wms-vb-blind-position-update': {
      const snr = msg.payload.snr;
      const dev = devices[snr] || {};
      log.debug('Position update:\n' + JSON.stringify(msg.payload, null, 2));
      // LED Loop-Schutz: Feedbacks nach HA-Steuerung ignorieren, aber Fernbedienung sofort übernehmen
      if (dev.type === "28") {
        if (typeof msg.payload.position === "undefined") {
          return;
        }

        const reported = normalizeWaremaBrightness(msg.payload.position);
        const d = ensureLedDevice(snr);
        const now = Date.now();

        // Wenn HA gerade steuert:
        if (d.commandActive) {

          // 1️ Ziel erreicht → Lock lösen
          if (reported === d.commandTarget) {
            d.commandActive = false;
            log.debug(`LED ${snr}: Target ${reported} erreicht.`);
            updateLightState(snr, reported);
            return;
          }

          // 2️ Timeout-Schutz (max 15s)
          if (now - d.commandStartTime > 15000) {
            log.warn(`LED ${snr}: Command timeout → Lock released.`);
            d.commandActive = false;
            updateLightState(snr, reported);
            return;
          }

          // 3️ Während Fahrt: Zwischenwerte ignorieren
          return;
        }

        // Fernbedienung → sofort live übernehmen
        updateLightState(snr, reported);
        return;
      }

      // Alle anderen Typen wie gehabt
      if (["20","21","25"].includes(dev.type)) {
        if (typeof msg.payload.position !== "undefined") {
          devices[snr].position = msg.payload.position;
          client.publish(`warema/${snr}/position`, '' + msg.payload.position, { retain: true });
          if (msg.payload.moving === false) {
            if (msg.payload.position === 0) {
			  if (dev.type === "20")
			  {
				client.publish(`warema/${snr}/state`, 'closed', { retain: true });
			  } else
			  {
				client.publish(`warema/${snr}/state`, 'open', { retain: true });			
			  }
              
            } else if (msg.payload.position === 100) {
			  if (dev.type === "20")
			  {
				client.publish(`warema/${snr}/state`, 'open', { retain: true });
			  } else
		      {
				client.publish(`warema/${snr}/state`, 'closed', { retain: true });
			  }
            } else {
              client.publish(`warema/${snr}/state`, 'stopped', { retain: true });
            }
          }
        }
        if (typeof msg.payload.angle !== "undefined") {
          devices[snr].tilt = msg.payload.angle;
          client.publish(`warema/${snr}/tilt`, '' + msg.payload.angle, { retain: true });
        }
      }
      break;
    }

    default:
      log.warn('UNKNOWN MESSAGE: ' + JSON.stringify(msg, null, 2));
  }

  if (client && client.connected) {
    client.publish('warema/bridge/state', 'online', { retain: true });
  }
}

function ensureLedDevice(snr) {
  if (!devices[snr]) {
    devices[snr] = { type: "28" };
  }
  const dev = devices[snr];
  dev.type = "28";
  return dev;
}

function updateLightState(snr, brightness) {
  const v = Math.max(0, Math.min(100, Number(brightness)));
  const now = Date.now();
  
  const dev = ensureLedDevice(snr);

  // Vereinfachter Loop-Schutz:
  // Ignoriere identischen Wert innerhalb von 2 Sekunden
  if (
    dev.lastPublishedBrightness === v &&
    (now - (dev.lastPublishTimestamp || 0)) < 2000
  ) {
    return;
  }

  dev.lastPublishedBrightness = v;
  dev.lastPublishTimestamp = now;
  devices[snr].position = v;

  // Letzte bekannte Helligkeit nur speichern, wenn >0
  if (v > 0) {
    devices[snr].lastBrightness = v;
    ledStateCache[snr] = v;
    saveLedState();
  }

  if (client && client.connected) {
    // Helligkeit publizieren
    client.publish(`warema/${snr}/light/brightness`, String(v), { retain: true });

    // ON/OFF automatisch abhängig von Helligkeit
    client.publish(`warema/${snr}/light/state`, v > 0 ? 'ON' : 'OFF', { retain: true });
  }
}

function restoreLedState(snr) {
  const dev = devices[snr];
  if (!dev || dev.type !== "28") return;
  // Lade aus Datei, falls vorhanden
  if (ledStateCache[snr] !== undefined) {
    dev.lastBrightness = ledStateCache[snr];
  }
  if (dev.lastBrightness === undefined) return;

  log.info(`Restoring LED state for ${snr}: ${dev.lastBrightness}%`);

  // Nur MQTT-State setzen, kein Hardware-Befehl!
  updateLightState(snr, dev.lastBrightness);
}

function syncAllDeviceStates() {
  // Query all registered covers and LED devices for their current state
  for (const snr of Object.keys(devices)) {
    const dev = devices[snr];
    // Only query covers and LED lights (types: 20, 21, 24, 25, 28, 2A)
    if (["20","21","25","28"].includes(dev.type)) {
      stickUsb.vnBlindGetPosition(snr, {
        cmdConfirmation: false,
        callbackOnUnchangedPos: true
      });
    }
  }
}

/** =========================
 *   Stick & MQTT Setup
 *  ========================= */
const stickUsb = new warema(
  settingsPar.wmsSerialPort,
  settingsPar.wmsChannel,
  settingsPar.wmsPanid,
  settingsPar.wmsKey,
  {},
  callback
);

// Do not attempt connecting to MQTT if trying to discover network parameters
if (settingsPar.wmsPanid === 'FFFF') {
  // Discovery-Phase, kein MQTT
  return;
}

const client = mqtt.connect(mqttServer, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  protocolVersion: parseInt(process.env.MQTT_VERSION || '4', 10),
  clientId: process.env.MQTT_CLIENTID || undefined,
  will: {
    topic: 'warema/bridge/state',
    payload: 'offline',
    retain: true
  }
});

client.on('connect', function () {
  mqttReady = true;
  log.info('Connected to MQTT');
  
  client.subscribe([
    'warema/+/set',
    'warema/+/set_position',
    'warema/+/set_tilt',
    // Light-spezifische Steuerung für Typ 28
    'warema/+/light/set',
    'warema/+/light/set_brightness'
  ]);

  trySystemReady();

  // Wetter-Polling starten
  if (!weatherInterval) {
    weatherInterval = setInterval(pollWeatherData, pollingInterval);
  }
});

client.on('close', () => {
  mqttReady = false;
  systemReady = false;
  log.warn('MQTT disconnected');
});

client.on('error', function (error) {
  log.error('MQTT Error: ' + (error && error.stack ? error.stack : error.toString()));
});

client.on('message', function (topic, message) {
  // const [scope, device, command] = topic.split('/');
  // const snr = device;
  
  const parts = topic.split('/');
  const scope = parts[0];
  const device = parts[1];
  const snr = device;
  const command = parts.slice(2).join('/');
  
  const dev = devices[snr] || {};
  message = message.toString();

  log.debug(`Received: scope=${scope}, device=${device}, command=${command}, payload=${message}`);

  switch (command) {
    // ======= Cover / allgemeine Geräte =======
    case 'set':
      switch (message) {
        case 'ON':
        case 'OFF':
          // (Platzhalter) Steckdosen etc.; hier keine LED-Logik
          break;
        case 'CLOSE':
		  if (dev.type === "20") {
			stickUsb.vnBlindSetPosition(snr, 0, 0);
			client.publish(`warema/${snr}/state`, 'closing', { retain: false });
		  } else {
			stickUsb.vnBlindSetPosition(snr, 100, 0);
			client.publish(`warema/${snr}/state`, 'closing', { retain: false });
		  }
          break;
        case 'CLOSETILT':
          stickUsb.vnBlindSetPosition(snr, 0, 100);
          client.publish(`warema/${snr}/state`, 'closing', { retain: false });
          break;
        case 'OPEN':
        case 'OPENTILT':
		  if (dev.type === "20") {
			stickUsb.vnBlindSetPosition(snr, 100, 0);
			client.publish(`warema/${snr}/state`, 'opening', { retain: false });
		  } else {
			stickUsb.vnBlindSetPosition(snr, 0, 0);
			client.publish(`warema/${snr}/state`, 'opening', { retain: false });
		  }
          break;
        case 'STOP':
          stickUsb.vnBlindStop(snr);
          break;
        default:
          log.warn('Unrecognised set payload: ' + message);
      }
      break;

    case 'set_position':
      log.debug('Setting ' + snr + ' to ' + message);
      stickUsb.vnBlindSetPosition(snr, parseInt(message, 10));
      break;

    case 'set_tilt':
      log.debug('Setting ' + snr + ' tilt to ' + message + '°, position ' + (devices[snr] ? devices[snr].position : '?'));
      stickUsb.vnBlindSetPosition(snr, parseInt(devices[snr]?.position ?? 0, 10), parseInt(message, 10));
      break;

    /** =========================
     *   LED / Light Handler
     *  ========================= */
    case 'light/set':
    case 'light/set_brightness': {
      let target = 0;

      if (command === 'light/set') {
        if (message.toUpperCase() === 'ON') {
          target = dev.lastBrightness ?? ledStateCache[snr] ?? 100;
        } else if (message.toUpperCase() === 'OFF') {
          target = 0;
        }
      } else {
        const haValue = Math.max(0, Math.min(100, parseInt(message, 10)));
        target = normalizeWaremaBrightness(haValue);
      }

      stickUsb.vnBlindSetPosition(snr, target, 0);

      const d = ensureLedDevice(snr);

      // Command-Lock aktivieren
      d.commandActive = true;
      d.commandTarget = target;
      d.commandStartTime = Date.now();

      updateLightState(snr, target);
      break;
    }

    default:
      log.warn('Unrecognised command: ' + command);
  }
});

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Shutting down addon (${reason})`);

  try {
    // Availability sauber auf offline
    if (client && client.connected) {
      client.publish('warema/bridge/state', 'offline', { retain: true });
      for (const snr of Object.keys(devices)) {
        client.publish(`warema/${snr}/availability`, 'offline', { retain: true });
      }
    }
    // Intervalle stoppen
    if (weatherInterval) {
      clearInterval(weatherInterval);
      weatherInterval = null;
    }
    // MQTT sauber schließen
    if (client) {
      await new Promise(resolve => client.end(false, resolve));
    }
    // Stick sauber freigeben (falls Lib das unterstützt)
    if (stickUsb?.close) {
      await stickUsb.close();
    }
  } catch (e) {
    log.error('Error during shutdown: ' + e.toString());
  } finally {
    setTimeout(() => process.exit(0), 100); // Give async cleanup a moment
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM (HA stop/restart)'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', err => {
  log.error(err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});

// Initialisierung: Wenn der Stick bereits verbunden ist, wird der Callback sofort aufgerufen
validateEnvVars();

const ENV_DEFAULTS = {
  MQTT_SERVER: mqttServer,
  WMS_CHANNEL: settingsPar.wmsChannel,
  WMS_KEY: settingsPar.wmsKey,
  WMS_PAN_ID: settingsPar.wmsPanid,
  WMS_SERIAL_PORT: settingsPar.wmsSerialPort
};

function validateEnvVars() {
  const requiredVars = [
    'MQTT_SERVER',
    'WMS_CHANNEL',
    'WMS_KEY',
    'WMS_PAN_ID',
    'WMS_SERIAL_PORT'
  ];
  for (const v of requiredVars) {
    if (!process.env[v]) {
      log.warn(`Environment variable ${v} is not set. Using default: ${ENV_DEFAULTS[v]}`);
    }
  }
  if (isNaN(pollingInterval) || pollingInterval <= 0) {
    log.warn('POLLING_INTERVAL is invalid or not set, using default 30000');
  }
  if (isNaN(movingInterval) || movingInterval <= 0) {
    log.warn('MOVING_INTERVAL is invalid or not set, using default 1000');
  }
  if (isNaN(WEATHER_EMA_ALPHA) || WEATHER_EMA_ALPHA <= 0 || WEATHER_EMA_ALPHA > 1) {
    log.warn('WEATHER_EMA_ALPHA is invalid or not set, using default 0.2');
  }
  if (isNaN(WEATHER_PUBLISH_INTERVAL_MS) || WEATHER_PUBLISH_INTERVAL_MS <= 0) {
    log.warn('WEATHER_PUBLISH_INTERVAL_MS is invalid or not set, using default 60000');
  }
}

// Hilfsfunktionen für persistente Speicherung
function saveLedState() {
  try {
    fs.writeFileSync(path.join(__dirname, 'led_state.json'), JSON.stringify(ledStateCache, null, 2));
  } catch (e) {
    log.error('Fehler beim Speichern von led_state.json: ' + e.toString());
  }
}

function loadLedState() {
  try {
    const file = path.join(__dirname, 'led_state.json');
    if (fs.existsSync(file)) {
      ledStateCache = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    log.error('Fehler beim Laden von led_state.json: ' + e.toString());
    ledStateCache = {};
  }
}

// Lade LED-State beim Start
loadLedState();
