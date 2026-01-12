
'use strict';

const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');

process.on('SIGINT', function () {
  process.exit(0);
});

/** =========================
 *   ENV / Defaults
 *  ========================= */
const mqttServer = process.env.MQTT_SERVER || 'mqtt://localhost';
const ignoredDevices = process.env.IGNORED_DEVICES ? process.env.IGNORED_DEVICES.split(',') : [];
const forceDevices = process.env.FORCE_DEVICES ? process.env.FORCE_DEVICES.split(',') : [];
const pollingInterval = parseInt(process.env.POLLING_INTERVAL || '30000', 10);
const movingInterval = parseInt(process.env.MOVING_INTERVAL || '1000', 10);

// Wind-Aggregation (leserliche Statistik)
const WIND_AGG_WINDOW_MS = parseInt(process.env.WIND_AGG_WINDOW_MS || '60000', 10);        // Fenster: 60s
const WIND_PUBLISH_INTERVAL_MS = parseInt(process.env.WIND_PUBLISH_INTERVAL_MS || '60000', 10); // Publizieren: 60s

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
const weatherCache = new Map();     // Cache für Weather-Dedup
const rawMessageCache = new Map();  // Cache für Hardware-Rohmeldungen Dedup
const windStats = new Map();        // SNR -> { samples: [{t, v}], lastPublish }

const WAREMA_LED_STEPS = [100,89,78,67,56,45,34,23,12,1];

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

// Wind: Sample hinzufügen und altes aus Fenster entfernen
function addWindSample(snr, windValue) {
  const now = Date.now();
  let entry = windStats.get(snr);
  if (!entry) {
    entry = { samples: [], lastPublish: 0 };
    windStats.set(snr, entry);
  }
  entry.samples.push({ t: now, v: Number(windValue) });
  // Fenster säubern
  entry.samples = entry.samples.filter(s => (now - s.t) <= WIND_AGG_WINDOW_MS);
}

// Wind: ggf. Durchschnitt publizieren
function maybePublishWindAverage(snr) {
  const entry = windStats.get(snr);
  const now = Date.now();
  if (!entry) return;
  if ((now - entry.lastPublish) < WIND_PUBLISH_INTERVAL_MS) return;

  const samples = entry.samples;
  if (!samples.length) return;

  const avg = samples.reduce((acc, s) => acc + s.v, 0) / samples.length;
  const rounded = Math.round(avg * 10) / 10; // eine Nachkommastelle

  if (client && client.connected) {
    client.publish(`warema/${snr}/wind/state`, rounded.toString(), { retain: true });
    entry.lastPublish = now;
    log.debug(`Published averaged wind ${rounded} m/s for ${snr}`);
  } else {
    log.warn(`MQTT client not connected, skipping averaged wind publish for ${snr}`);
  }
}

/** =========================
 *   Weather polling
 *  ========================= */
function pollWeatherData() {
  try {
    const weatherData = stickUsb.getLastWeatherBroadcast();
    if (weatherData && weatherData.snr) {
      const weatherKey = weatherData.snr;
      const currentTime = Date.now();
      const weatherHash = `${weatherData.temp}_${weatherData.wind}_${weatherData.lumen}_${weatherData.rain}`;
      const cachedWeather = weatherCache.get(weatherKey);
      const minTimeDiff = 5000; // mindestens 5s zwischen identischen Nachrichten

      const shouldSend =
        !cachedWeather ||
        cachedWeather.hash !== weatherHash ||
        (currentTime - cachedWeather.timestamp) > minTimeDiff;

      // Gerät registrieren (Sensoren) falls nötig
      if (!devices[weatherData.snr]) {
        registerDevice({ snr: weatherData.snr, type: "63" });
      }

      // Wind immer sammeln; Veröffentlichung zeitgesteuert
      addWindSample(weatherData.snr, weatherData.wind);
      maybePublishWindAverage(weatherData.snr);

      if (shouldSend) {
        if (client && client.connected) {
          client.publish(`warema/${weatherData.snr}/illuminance/state`, weatherData.lumen.toString(), { retain: true });
          client.publish(`warema/${weatherData.snr}/temperature/state`, weatherData.temp.toString(), { retain: true });
          // Wind wird durch Aggregator veröffentlicht
          client.publish(`warema/${weatherData.snr}/rain/state`, weatherData.rain ? 'ON' : 'OFF', { retain: true });
        } else {
          log.warn(`MQTT client not connected, skipping weather data publish for ${weatherKey}`);
        }
        weatherCache.set(weatherKey, { hash: weatherHash, timestamp: currentTime });
      } else {
        log.debug(`Skipping duplicate weather data for ${weatherKey} (hash: ${weatherHash}) via polling`);
      }
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
        default_entity_id: `sensor.${element.snr}_rain`,
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

    case "20": { // Plug receiver (als Cover)
      model = 'Plug receiver';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        position_open: 0,
        position_closed: 100,
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
        color_mode: "brightness",
        payload_on: 'ON',
        payload_off: 'OFF',
        optimistic: true,
        unique_id: `${element.snr}_light`,
        default_entity_id: `light.${element.snr}`
      };
      topicForDiscovery = `homeassistant/light/${element.snr}/${element.snr}/config`;
      break;
    }

    case "2A": { // Slat roof
      model = 'Slat roof';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        tilt_status_topic: `warema/${element.snr}/tilt`,
        tilt_command_topic: `warema/${element.snr}/set_tilt`,
        position_topic: `warema/${element.snr}/position`,
        set_position_topic: `warema/${element.snr}/set_position`,
      };
      topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;
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
  if (element.type !== "63") {
    stickUsb.vnBlindAdd(parseInt(element.snr, 10), element.snr.toString());
  }
  devices[element.snr] = { type: element.type, lastBrightness: 100 };

  // Availability online setzen
  if (client && client.connected) {
    client.publish(availability_topic, 'online', { retain: true });
  }

  // Discovery publizieren
  client.publish(topicForDiscovery, JSON.stringify(payload), { retain: true });
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
      log.info('Warema init completed');
      stickUsb.setPosUpdInterval(pollingInterval);
      stickUsb.setWatchMovingBlindsInterval(movingInterval);
      log.info('Scanning...');
      stickUsb.scanDevices({ autoAssignBlinds: false });
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

      // Wind immer in Aggregator
      addWindSample(w.snr, w.wind);
      maybePublishWindAverage(w.snr);

      // Dedup Hash für die restlichen Werte
      const weatherKey = w.snr;
      const currentTime = Date.now();
      const weatherHash = `${w.temp}_${w.wind}_${w.lumen}_${w.rain}`;
      const cachedWeather = weatherCache.get(weatherKey);
      const minTimeDiff = 5000;

      const shouldSend =
        !cachedWeather ||
        cachedWeather.hash !== weatherHash ||
        (currentTime - cachedWeather.timestamp) > minTimeDiff;

      if (shouldSend) {
        if (client && client.connected) {
          client.publish(`warema/${w.snr}/illuminance/state`, w.lumen.toString(), { retain: true });
          client.publish(`warema/${w.snr}/temperature/state`, w.temp.toString(), { retain: true });
          // Wind: wird über Aggregator gesendet
          client.publish(`warema/${w.snr}/rain/state`, w.rain ? 'ON' : 'OFF', { retain: true });
        } else {
          log.warn('MQTT client not connected, skipping weather data publish for ' + weatherKey);
        }
        weatherCache.set(weatherKey, { hash: weatherHash, timestamp: currentTime });
      } else {
        log.debug('Skipping duplicate weather data for ' + weatherKey + ' (hash: ' + weatherHash + ')');
      }
      break;
    }

    case 'wms-vb-blind-position-update': {
      const snr = msg.payload.snr;
      const dev = devices[snr] || {};
      log.debug('Position update:\n' + JSON.stringify(msg.payload, null, 2));

      // Für LED: Position = Helligkeit
      if (dev.type === "28") {
         const now = Date.now();

         // Wenn HA kürzlich gesteuert hat → ignorieren (Loop-Schutz)
         if (dev.haControlUntil && now < dev.haControlUntil) {
           return;
         }

         // Nur Endzustände von externer Steuerung (Fernbedienung)
         if (
           typeof msg.payload.position !== "undefined" &&
           msg.payload.moving === false
         ) {
           const brightness = normalizeWaremaBrightness(msg.payload.position);
           updateLightState(snr, brightness);
         }
         return;
      } else {
        // Standard Cover-Handling
        if (typeof msg.payload.position !== "undefined") {
          devices[snr].position = msg.payload.position;
          client.publish(`warema/${snr}/position`, '' + msg.payload.position, { retain: true });
          if (msg.payload.moving === false) {
            if (msg.payload.position === 0) {
              client.publish(`warema/${snr}/state`, 'open', { retain: true });
            } else if (msg.payload.position === 100) {
              client.publish(`warema/${snr}/state`, 'closed', { retain: true });
            } else {
              client.publish(`warema/${snr}/state`, 'stopped', { retain: true });
            }
          }
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

function updateLightState(snr, brightness) {
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
    client.publish(`warema/${snr}/light/brightness`, String(v), { retain: false });

    // ON/OFF automatisch abhängig von Helligkeit
    client.publish(`warema/${snr}/light/state`, v > 0 ? 'ON' : 'OFF', { retain: false });
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
  client.subscribe([
    'warema/+/set',
    'warema/+/set_position',
    'warema/+/set_tilt',
    // Light-spezifische Steuerung für Typ 28
    'warema/+/light/set',
    'warema/+/light/set_brightness'
  ]);

  // Wetter-Polling starten
  setInterval(pollWeatherData, pollingInterval);
  log.info('Started weather data polling every ' + pollingInterval + ' ms');
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
      updateLightState(snr, target);
      break;
    }

    default:
      log.warn('Unrecognised command: ' + command);
  }
});
