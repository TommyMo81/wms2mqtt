
'use strict';

const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');
const DEVICE_CACHE_FILE = '/data/devices.json';

let shuttingDown = false;
let mqttReady = false;
let stickReady = false;
let weatherInterval = null;

/** =========================
 *   ENV / Defaults
 *  ========================= */
const mqttServer = process.env.MQTT_SERVER || 'mqtt://localhost';
const ignoredDevices = process.env.IGNORED_DEVICES ? process.env.IGNORED_DEVICES.split(',') : [];
const forceDevices = process.env.FORCE_DEVICES ? process.env.FORCE_DEVICES.split(',') : [];
const devicePollingInterval = parseInt(process.env.DEVICE_POLLING_INTERVAL || '2000', 10);
const weatherPollingInterval = parseInt(process.env.WEATHER_POLLING_INTERVAL || '30000', 10);
const movingInterval = parseInt(process.env.MOVING_INTERVAL || '2000', 10);

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

// Regen-Hysterese
const rainState = new Map(); // snr -> { state, lastChange }
const RAIN_ON_DELAY  = parseInt(process.env.RAIN_ON_DELAY  || '10000', 10); // ms
const RAIN_OFF_DELAY = parseInt(process.env.RAIN_OFF_DELAY || '30000', 10); // ms

const WAREMA_LED_STEPS = [100,89,78,67,56,45,34,23,12,1];

/** =========================
 *   Helpers
 *  ========================= */

function rebindDevices() {
  log.info('Rebinding devices to WMS stick...');

  // 1. Erneut scannen (wichtig!)
  stickUsb.scanDevices({ autoAssignBlinds: false });

  // 2. Availability neu setzen
  if (client && client.connected) {
    client.publish('warema/bridge/state', 'online', { retain: true });

    for (const snr of Object.keys(devices)) {
      client.publish(`warema/${snr}/availability`, 'online', { retain: true });
    }
  }
}

function reRegisterKnownDevices() {
  for (const [snr, dev] of Object.entries(devices)) {
    registerDevice({ snr, type: dev.type });
  }
}

function loadDeviceCache() {
  try {
    if (fs.existsSync(DEVICE_CACHE_FILE)) {
      Object.assign(devices, JSON.parse(fs.readFileSync(DEVICE_CACHE_FILE)));
      log.info('Loaded device cache');
    }
  } catch (e) {
    log.warn('Failed to load device cache');
  }
}

function saveDeviceCache() {
  try {
    fs.writeFileSync(DEVICE_CACHE_FILE, JSON.stringify(devices, null, 2));
  } catch {}
}


/**
 * Publiziert den initialen Zustand eines Geräts direkt nach der Registrierung / Availability.
 * @param {string} snr - Seriennummer / ID des Geräts
 * @param {string} type - Gerätetyp ("28"=LED, "21/25/2A/20/24"=Cover, "63"=Wetterstation)
 */
function publishInitialState(snr, type) {
  if (!client || !client.connected) return;
  const dev = devices[snr];
  if (!dev) return;

  switch (type) {
    // ======= LED / Light =======
    case "28": {
      // Wenn keine gespeicherte Helligkeit vorhanden → LED aus
      const brightness = dev.lastBrightness ?? 0;
      const isOn = brightness > 0;

      client.publish(`warema/${snr}/light/brightness`, String(brightness), { retain: true });
      client.publish(`warema/${snr}/light/state`, isOn ? 'ON' : 'OFF', { retain: true });
      break;
    }

    // ======= Cover / Aktoren =======
    case "21": case "25": case "2A": case "20": case "24": {
      // Position nur publizieren, wenn vom Stick bekannt
      if (typeof dev.position === 'number') {
        client.publish(`warema/${snr}/position`, '' + dev.position, { retain: true });
        let state;
        if (dev.position === 0) state = 'open';
        else if (dev.position === 100) state = 'closed';
        else state = 'stopped';
        client.publish(`warema/${snr}/state`, state, { retain: true });
      }

      // Tilt nur publizieren, wenn vom Stick bekannt
      if (typeof dev.tilt === 'number') {
        client.publish(`warema/${snr}/tilt`, '' + dev.tilt, { retain: true });
      }
      break;
    }

    // ======= Wetterstation =======
    case "63": {
      const w = weatherStats.get(snr) || {};
      if (w.lumen !== undefined) client.publish(`warema/${snr}/illuminance/state`, Math.round(w.lumen).toString(), { retain: true });
      if (w.temp  !== undefined) client.publish(`warema/${snr}/temperature/state`, w.temp.toFixed(1), { retain: true });
      if (w.wind  !== undefined) client.publish(`warema/${snr}/wind/state`, w.wind.toFixed(1), { retain: true });
      if (w.rain  !== undefined) client.publish(`warema/${snr}/rain/state`, w.rain ? 'ON' : 'OFF', { retain: true });
      break;
    }

    default:
      log.warn('publishInitialState: Unrecognized device type: ' + type);
  }
}



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

  if (client && client.connected) {
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
    if (client && client.connected) {
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
function registerDevice(element) {
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

  if (ignoredDevices.includes(element.snr.toString())) {
    log.info('Ignoring device ' + element.snr + ' (type ' + element.type + ')');
    return;
  }

  switch (element.type) {

    // === Wetterstation ===
    case "63": {
      model = 'Weather station pro';
      const payloadBase = { ...base_payload, device: { ...base_device, model } };

      // Illuminance
      client.publish(`homeassistant/sensor/${element.snr}/illuminance/config`,
        JSON.stringify({ ...payloadBase,
          state_topic: `warema/${element.snr}/illuminance/state`,
          device_class: 'illuminance',
          unique_id: `${element.snr}_illuminance`,
          unit_of_measurement: 'lx',
          state_class: 'measurement'
        }), { retain: true });

      // Temperatur
      client.publish(`homeassistant/sensor/${element.snr}/temperature/config`,
        JSON.stringify({ ...payloadBase,
          state_topic: `warema/${element.snr}/temperature/state`,
          device_class: 'temperature',
          unique_id: `${element.snr}_temperature`,
          unit_of_measurement: '°C',
          state_class: 'measurement',
          suggested_display_precision: 1
        }), { retain: true });

      // Wind
      client.publish(`homeassistant/sensor/${element.snr}/wind/config`,
        JSON.stringify({ ...payloadBase,
          state_topic: `warema/${element.snr}/wind/state`,
          device_class: 'wind_speed',
          unique_id: `${element.snr}_wind`,
          unit_of_measurement: 'm/s',
          state_class: 'measurement'
        }), { retain: true });

      // Regen
      client.publish(`homeassistant/binary_sensor/${element.snr}/rain/config`,
        JSON.stringify({ ...payloadBase,
          state_topic: `warema/${element.snr}/rain/state`,
          device_class: 'moisture',
          unique_id: `${element.snr}_rain`
        }), { retain: true });

      if (client && client.connected) client.publish(availability_topic, 'online', { retain: true });

      devices[element.snr] = { type: element.type };
      log.info('Registered Weather Station ' + element.snr);
      return;
    }

    // === LED ===
    case "28": {
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
        color_mode: "brightness",
        payload_on: 'ON',
        payload_off: 'OFF',
        optimistic: true,
        unique_id: `${element.snr}_light`,
        default_entity_id: `light.${element.snr}`
      };
      topicForDiscovery = `homeassistant/light/${element.snr}/${element.snr}/config`;

      // LED initialisieren
      devices[element.snr] = {
        type: element.type,
        lastBrightness: devices[element.snr]?.lastBrightness ?? 0,
        isOn: false
      };
      break;
    }

    // === Cover ===
    case "21": case "25": case "2A": case "20": case "24": {
      model = element.type === "21" ? 'Actuator UP' :
              element.type === "25" ? 'Vertical awning' :
              element.type === "2A" ? 'Slat roof' :
              element.type === "20" ? 'Plug receiver' :
              'Smart socket';

      payload = {
        ...base_payload,
        device: { ...base_device, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${element.snr}/set`,
        position_topic: `warema/${element.snr}/position`,
        set_position_topic: `warema/${element.snr}/set_position`
      };

      if (["21","2A"].includes(element.type)) {
        payload.tilt_status_topic = `warema/${element.snr}/tilt`;
        payload.tilt_command_topic = `warema/${element.snr}/set_tilt`;
        payload.tilt_min = -100;
        payload.tilt_max = 100;
      }

      topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;

      // Cover initialisieren: keine Position → HA bleibt unknown
      devices[element.snr] = {
        type: element.type,
        position: undefined,
        tilt: undefined
      };
      break;
    }

    default:
      log.warn('Unrecognized device type: ' + element.type);
      return;
  }

  // Für steuerbare Geräte auf Stick legen
  if (!["63"].includes(element.type)) {
    stickUsb.vnBlindAdd(parseInt(element.snr, 10), element.snr.toString());
  }

  // Availability online setzen
  if (client && client.connected) {
    client.publish(availability_topic, 'online', { retain: true });

    // LED sofort Initialzustand publizieren, Cover erst nach Stick-Update
    if (element.type === "28") {
      publishInitialState(element.snr, element.type);
    }
  }

  // Discovery publizieren
  if (topicForDiscovery && payload) client.publish(topicForDiscovery, JSON.stringify(payload), { retain: true });

  // Device cache speichern (nur LED relevant)
  if (element.type === "28") saveDeviceCache();
}


function initStick() {
  log.info('Initializing WMS stick...');
  stickReady = false;

  stickUsb.setPosUpdInterval(devicePollingInterval);
  stickUsb.setWatchMovingBlindsInterval(movingInterval);

  // Explizit scannen
  stickUsb.scanDevices({ autoAssignBlinds: false });
}

function tryFullRebind() {
  if (!mqttReady || !stickReady || shuttingDown) return;

  log.info('Performing full device rebind');

  // 1. Geräte neu scannen
  stickUsb.scanDevices({ autoAssignBlinds: false });

  // 2. Availability neu setzen
  for (const snr of Object.keys(devices)) {
    client.publish(`warema/${snr}/availability`, 'online', { retain: true });
  }
}

/** =========================
 *   Stick Callback
 *  ========================= */
function callback(err, msg) {
  if (err) {
    log.error(err);
  }
  if (!msg) return;

  log.debug('Callback received topic: ' + msg.topic);

  switch (msg.topic) {
    case 'wms-vb-init-completion':
      log.info('Warema stick ready');
      stickReady = true;
      initStick();
	  tryFullRebind();
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
	  if (!dev) break;
      log.debug('Position update:\n' + JSON.stringify(msg.payload, null, 2));

      // Für LED: Position = Helligkeit
      if (dev.type === "28") {
         const now = Date.now();

         // Wenn HA kürzlich gesteuert hat → ignorieren (Loop-Schutz)
         //if (dev.haControlUntil && now < dev.haControlUntil) {
         //  return;
         //}

         // Nur Endzustände von externer Steuerung (Fernbedienung)
         if (
           typeof msg.payload.position !== "undefined" &&
           msg.payload.moving === false
         ) {
           const brightness = normalizeWaremaBrightness(msg.payload.position);
           // Stick ist führend
           if (brightness > 0) {
             devices[snr].lastBrightness = brightness;
           }
           updateLightState(snr, brightness, true);
         }
         return;
      } else {
        // Standard Cover-Handling
        if (typeof msg.payload.position !== "undefined") {
          dev.position = msg.payload.position;
		  dev.positionFromStick = true;
		  
		  const retainState = dev.lastPosition === undefined;
		  
          client.publish(`warema/${snr}/position`, '' + dev.position, { retain: retainState });
		  
          let state;
          if (msg.payload.moving === true) {
            state = dev.position > (dev.lastPosition ?? 0) ? 'closing' : 'opening';
          } else {
            state =
              dev.position === 0 ? 'open' :
              dev.position === 100 ? 'closed' : 'stopped';
          }

          client.publish(`warema/${snr}/state`, state, { retain: retainState });
          dev.lastPosition = dev.position;
        }
        if (typeof msg.payload.angle !== "undefined") {
          devices[snr].tilt = msg.payload.tilt;
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

function updateLightState(snr, brightness, retain = false) {
  const v = Math.max(0, Math.min(100, Number(brightness)));

  if (!devices[snr]) devices[snr] = {};
  devices[snr].type = "28";
  devices[snr].position = v;

  // Letzte bekannte Helligkeit nur speichern, wenn >0
  if (v > 0) {
	devices[snr].lastBrightness = v;
  }

  if (client && client.connected) {
    // Helligkeit publizieren
    client.publish(`warema/${snr}/light/brightness`, String(v), { retain });
    client.publish(`warema/${snr}/light/state`, v > 0 ? 'ON' : 'OFF', { retain });
  }
}


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

//===========================
// Load persisted device cache
//===========================
loadDeviceCache();

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
  log.info('Connected to MQTT');
  mqttReady = true;
  
  client.subscribe([
    'warema/+/set',
    'warema/+/set_position',
    'warema/+/set_tilt',
    // Light-spezifische Steuerung für Typ 28
    'warema/+/light/set',
    'warema/+/light/set_brightness'
  ]);
  
  client.publish('warema/bridge/state', 'online', { retain: true });

  // Wetter-Polling starten
  if (!weatherInterval) {
    weatherInterval = setInterval(pollWeatherData, weatherPollingInterval);
  }

  tryFullRebind();
});

client.on('close', () => {
  mqttReady = false;
  log.warn('MQTT disconnected');
});

client.on('error', function (error) {
  log.error('MQTT Error: ' + error.toString());
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
          stickUsb.vnBlindSetPosition(snr, 100, 0);
          client.publish(`warema/${snr}/state`, 'closing', { retain: false });
          break;
        case 'CLOSETILT':
          stickUsb.vnBlindSetPosition(snr, 0, 100);
          client.publish(`warema/${snr}/state`, 'closing', { retain: false });
          break;
        case 'OPEN':
        case 'OPENTILT':
          stickUsb.vnBlindSetPosition(snr, 0, 0);
          client.publish(`warema/${snr}/state`, 'opening', { retain: false });
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

    // ======= LED / Light (Typ 28) =======
    case 'light.set': // defensiv, falls Broker Subtopic anders zusammensetzt
      // nichts
      break;

    /** =========================
     *   LED / Light Handler
     *  ========================= */
    case 'light/set':
    case 'light/set_brightness': {
      let target = 0;

      if (command === 'light/set') {
        if (message.toUpperCase() === 'ON') {
          target = dev.lastBrightness ?? 100;
		  updateLightState(snr, target, true); // <-- WICHTIG
        } else if (message.toUpperCase() === 'OFF') {
          target = 0;
        }
      } else {
        const haValue = Math.max(0, Math.min(100, parseInt(message, 10)));
        target = normalizeWaremaBrightness(haValue);
      }

      stickUsb.vnBlindSetPosition(snr, target, 0);

      devices[snr].haControlUntil = Date.now() + 3000;
	  
      // nur lokal merken, NICHT als Feedbackschleife
      updateLightState(snr, target, false);
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
      stickUsb.close();
    }
  } catch (e) {
    log.error('Error during shutdown: ' + e.toString());
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM (HA stop/restart)'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', err => {
  log.error(err);
  shutdown('uncaughtException');
});
