'use strict';

const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');

/**
 * =========================
 * ENV / Defaults (preserve original names)
 * =========================
 * NOTE: All previously used process.env variables are kept as-is:
 *  - MQTT_SERVER, MQTT_USER, MQTT_PASSWORD, MQTT_VERSION, MQTT_CLIENTID
 *  - IGNORED_DEVICES, FORCE_DEVICES
 *  - POLLING_INTERVAL, MOVING_INTERVAL
 *  - WIND_AGG_WINDOW_MS, WIND_PUBLISH_INTERVAL_MS
 *  - WMS_CHANNEL, WMS_KEY, WMS_PAN_ID, WMS_SERIAL_PORT
 * New variables are optional and do not alter behavior when unset:
 *  - MQTT_QOS, LED_FINALIZE_MS, PERSIST_STATE, STATE_FILE, TEMP_EPS, LUMEN_EPS, LED_ROUND_MODE
 */
const toInt = (val, def) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
};
const toBool = (val, def=false) => {
  if (val === undefined) return def;
  return ['1','true','TRUE','yes','YES','on','ON'].includes(String(val));
};

// === ORIGINAL ENV NAMES ===
const mqttServer = process.env.MQTT_SERVER || 'mqtt://localhost';
const ignoredDevices = process.env.IGNORED_DEVICES ? process.env.IGNORED_DEVICES.split(',') : [];
const forceDevices = process.env.FORCE_DEVICES ? process.env.FORCE_DEVICES.split(',') : [];
const pollingInterval = toInt(process.env.POLLING_INTERVAL, 30000);
const movingInterval = toInt(process.env.MOVING_INTERVAL, 1000);
const settingsPar = {
  wmsChannel: toInt(process.env.WMS_CHANNEL, 17),
  wmsKey: process.env.WMS_KEY || '00112233445566778899AABBCCDDEEFF',
  wmsPanid: process.env.WMS_PAN_ID || 'FFFF',
  wmsSerialPort: process.env.WMS_SERIAL_PORT || '/dev/ttyUSB0',
};
const WIND_AGG_WINDOW_MS = toInt(process.env.WIND_AGG_WINDOW_MS, 60000);
const WIND_PUBLISH_INTERVAL_MS = toInt(process.env.WIND_PUBLISH_INTERVAL_MS, 60000);

// === OPTIONAL NEW ENV NAMES ===
const MQTT_QOS = toInt(process.env.MQTT_QOS, 0);
const LED_FINALIZE_MS = toInt(process.env.LED_FINALIZE_MS, 1000);
const PERSIST_STATE = toBool(process.env.PERSIST_STATE, false);
const STATE_FILE = process.env.STATE_FILE || 'devices-state.json';
const TEMP_EPS = Number(process.env.TEMP_EPS ?? 0.1);
const LUMEN_EPS = Number(process.env.LUMEN_EPS ?? 1);
const LED_ROUND_MODE = (process.env.LED_ROUND_MODE || 'nearest').toLowerCase();

/**
 * =========================
 * Types & Constants
 * =========================
 */
const TYPE = {
  WEATHER: "63",
  REMOTE_PRO: "07",
  WEBCONTROL_PRO: "09",
  PLUG: "20",
  ACTUATOR_UP: "21",
  SMART_SOCKET: "24",
  VERTICAL_AWNING: "25",
  LED: "28",
  SLAT_ROOF: "2A",
};

const WAREMA_LED_STEPS = [100, 89, 78, 67, 56, 45, 34, 23, 12, 1];

/**
 * =========================
 * State
 * =========================
 */
const devices = {}; // Map SNR -> { type, position, tilt, lastBrightness, haControlUntil, pendingLightFinalize }
const weatherCache = new Map();
const rawMessageCache = new Map();
const windStats = new Map();
let weatherPollTimer = null;
let rawCacheCleanerTimer = null;
let client = null;

/**
 * =========================
 * Helpers
 * =========================
 */
const toSnrNum = snr => toInt(snr, 0);

function publish(topic, payload, { retain = true, qos = MQTT_QOS } = {}) {
  if (!client || !client.connected) {
    log.warn(`MQTT not connected. Skipping publish to ${topic}`);
    return;
  }
  try {
    client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain, qos });
  } catch (e) {
    log.error(`Publish error for ${topic}: ${e}`);
  }
}

function isDuplicateRawMessage(stickCmd, snr) {
  const currentTime = Date.now();
  const messageKey = `${snr}_${stickCmd}`;
  const cached = rawMessageCache.get(messageKey);
  const minTimeDiff = 1000;
  if (cached && (currentTime - cached.timestamp) < minTimeDiff) return true;
  rawMessageCache.set(messageKey, { timestamp: currentTime });
  return false;
}

function startRawCacheCleaner() {
  if (rawCacheCleanerTimer) return;
  rawCacheCleanerTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rawMessageCache.entries()) {
      if ((now - value.timestamp) > 10000) rawMessageCache.delete(key);
    }
  }, 5000);
}

function addWindSample(snr, windValue) {
  const now = Date.now();
  let entry = windStats.get(snr);
  if (!entry) {
    entry = { samples: [], lastPublish: 0 };
    windStats.set(snr, entry);
  }
  entry.samples.push({ t: now, v: Number(windValue) });
  entry.samples = entry.samples.filter(s => (now - s.t) <= WIND_AGG_WINDOW_MS);
}

function computeWindStats(snr) {
  const entry = windStats.get(snr);
  if (!entry || !entry.samples.length) return null;
  const vals = entry.samples.map(s => s.v);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return { avg: Math.round(avg * 10) / 10, min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
}

function maybePublishWindStats(snr) {
  const entry = windStats.get(snr);
  const now = Date.now();
  if (!entry) return;
  if ((now - entry.lastPublish) < WIND_PUBLISH_INTERVAL_MS) return;
  const stats = computeWindStats(snr);
  if (!stats) return;
  publish(`warema/${snr}/wind/state`, stats.avg.toString());
  publish(`warema/${snr}/wind_max/state`, stats.max.toString());
  publish(`warema/${snr}/wind_min/state`, stats.min.toString());
  entry.lastPublish = now;
}

function shouldPublishWeather(snr, weather) {
  const currentTime = Date.now();
  const cached = weatherCache.get(snr);
  const minTimeDiff = 5000;
  if (!cached) return true;
  if ((currentTime - cached.timestamp) <= minTimeDiff) return false;
  const last = cached.last || {};
  const tempChanged = Math.abs(Number(weather.temp) - Number(last.temp ?? weather.temp)) >= TEMP_EPS;
  const lumenChanged = Math.abs(Number(weather.lumen) - Number(last.lumen ?? weather.lumen)) >= LUMEN_EPS;
  const rainChanged = Boolean(weather.rain) !== Boolean(last.rain ?? weather.rain);
  return tempChanged || lumenChanged || rainChanged;
}

function updateWeatherCache(snr, weather) {
  weatherCache.set(snr, { last: { temp: weather.temp, wind: weather.wind, lumen: weather.lumen, rain: weather.rain }, timestamp: Date.now() });
}

function normalizeWaremaBrightness(v) {
  const val = Math.max(0, Math.min(100, Number(v)));
  if (val <= 0) return 0;

  const sorted = [...WAREMA_LED_STEPS].sort((a, b) => a - b);

  if (LED_ROUND_MODE === 'floor') {
    let result = sorted[0];
    for (const s of sorted) {
      if (s <= val) result = s;
    }
    return result;
  }

  if (LED_ROUND_MODE === 'ceil') {
    for (const s of sorted) {
      if (s >= val) return s;
    }
    return sorted[sorted.length - 1];
  }

  // nearest (default)
  let best = sorted[0];
  let diff = Math.abs(val - best);
  for (const s of sorted) {
    const d = Math.abs(val - s);
    if (d < diff) {
      diff = d;
      best = s;
    }
  }
  return best;
}


function updateLightState(snr, brightness) {
  const v = Math.max(0, Math.min(100, Number(brightness)));
  if (!devices[snr]) devices[snr] = {};
  devices[snr].type = TYPE.LED;
  devices[snr].position = v;
  if (v > 0) devices[snr].lastBrightness = v;
  publish(`warema/${snr}/light/brightness`, String(v), { retain: true });
  publish(`warema/${snr}/light/state`, v > 0 ? 'ON' : 'OFF', { retain: true });
}

function callStickSetPosition(snr, position, tilt=0, retry=1) {
  try {
    stickUsb.vnBlindSetPosition(snr, position, tilt);
  } catch (e) {
    if (retry > 0) setTimeout(() => callStickSetPosition(snr, position, tilt, retry-1), 250);
  }
}

/**
 * =========================
 * Device registration
 * =========================
 */

function registerDevice(element) {
  log.info(`Registering ${element.snr} with type: ${element.type}`);
  const availability_topic = `warema/${element.snr}/availability`;
  const base_payload = {
    availability: [
      { topic: 'warema/bridge/state' },
      { topic: availability_topic }
    ],
    unique_id: element.snr,
    name: null,
    availability_mode: 'latest'
  };
  const base_device = {
    identifiers: element.snr,
    manufacturer: 'Warema',
    name: element.snr
  };

  let payload;
  let model;
  let topicForDiscovery;

  switch (element.type) {
    case TYPE.WEATHER: {
      model = 'Weather station pro';
      const payloadBase = { ...base_payload, device: { ...base_device, model } };
      publish(`homeassistant/sensor/${element.snr}/illuminance/config`, {
        ...payloadBase,
        state_topic: `warema/${element.snr}/illuminance/state`,
        device_class: 'illuminance',
        unique_id: `${element.snr}_illuminance`,
        unit_of_measurement: 'lx',
        state_class: 'measurement'
      });
      publish(`homeassistant/sensor/${element.snr}/temperature/config`, {
        ...payloadBase,
        state_topic: `warema/${element.snr}/temperature/state`,
        device_class: 'temperature',
        unique_id: `${element.snr}_temperature`,
        unit_of_measurement: '°C',
        state_class: 'measurement',
        suggested_display_precision: 1
      });
      publish(`homeassistant/sensor/${element.snr}/wind/config`, {
        ...payloadBase,
        state_topic: `warema/${element.snr}/wind/state`,
        device_class: 'wind_speed',
        unique_id: `${element.snr}_wind_avg`,
        unit_of_measurement: 'm/s',
        state_class: 'measurement',
        suggested_display_precision: 1
      });
      publish(`homeassistant/sensor/${element.snr}/wind_max/config`, {
        ...payloadBase,
        state_topic: `warema/${element.snr}/wind_max/state`,
        device_class: 'wind_speed',
        unique_id: `${element.snr}_wind_max`,
        unit_of_measurement: 'm/s',
        state_class: 'measurement',
        suggested_display_precision: 1
      });
      publish(`homeassistant/sensor/${element.snr}/wind_min/config`, {
        ...payloadBase,
        state_topic: `warema/${element.snr}/wind_min/state`,
        device_class: 'wind_speed',
        unique_id: `${element.snr}_wind_min`,
        unit_of_measurement: 'm/s',
        state_class: 'measurement',
        suggested_display_precision: 1
      });
      publish(`homeassistant/binary_sensor/${element.snr}/rain/config`, {
        ...payloadBase,
        state_topic: `warema/${element.snr}/rain/state`,
        device_class: 'moisture',
        unique_id: `${element.snr}_rain`
      });
      publish(availability_topic, 'online', { retain: true });
      devices[element.snr] = { type: element.type };
      return;
    }
    case TYPE.REMOTE_PRO:
    case TYPE.WEBCONTROL_PRO:
      return;
    case TYPE.PLUG: {
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
    case TYPE.ACTUATOR_UP: {
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
    case TYPE.SMART_SOCKET: {
      model = 'Smart socket';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        state_topic: `warema/${element.snr}/state`,
        command_topic: `warema/${element.snr}/set`
      };
      topicForDiscovery = `homeassistant/switch/${element.snr}/${element.snr}/config`;
      break;
    }
    case TYPE.VERTICAL_AWNING: {
      model = 'Vertical awning';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        position_open: 0,
        position_closed: 100,
        command_topic: `warema/${element.snr}/set`,
        position_topic: `warema/${element.snr}/position`,
        set_position_topic: `warema/${element.snr}/set_position`
      };
      topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;
      break;
    }
    case TYPE.LED: {
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
        optimistic: true,
        unique_id: `${element.snr}_light`
      };
      topicForDiscovery = `homeassistant/light/${element.snr}/${element.snr}/config`;
      break;
    }
    case TYPE.SLAT_ROOF: {
      model = 'Slat roof';
      payload = {
        ...base_payload,
        device: { ...base_device, model },
        tilt_status_topic: `warema/${element.snr}/tilt`,
        tilt_command_topic: `warema/${element.snr}/set_tilt`,
        position_topic: `warema/${element.snr}/position`,
        set_position_topic: `warema/${element.snr}/set_position`
      };
      topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;
      break;
    }
    default:
      log.warn(`Unrecognized device type: ${element.type}`);
      return;
  }

  if (ignoredDevices.includes(String(element.snr))) return;
  if (element.type !== TYPE.WEATHER) {
    stickUsb.vnBlindAdd(toSnrNum(element.snr), String(element.snr));
  }
  devices[element.snr] = {...(devices[element.snr] || {}), type: element.type,  lastBrightness: devices[element.snr]?.lastBrightness ?? 100};

  publish(availability_topic, 'online', { retain: true });
  publish(topicForDiscovery, payload, { retain: true });
}

/**
 * =========================
 * Stick Callback
 * =========================
 */
function callback(err, msg) {
  if (err) log.error(err);
  if (!msg) return;

  switch (msg.topic) {
    case 'wms-vb-init-completion':
      stickUsb.setPosUpdInterval(pollingInterval);
      stickUsb.setWatchMovingBlindsInterval(movingInterval);
      stickUsb.scanDevices({ autoAssignBlinds: false });
      break;

    case 'wms-vb-scanned-devices':
      if (forceDevices && forceDevices.length) {
        forceDevices.forEach(deviceString => {
          const [snr, type] = deviceString.split(':');
          registerDevice({ snr, type: type || TYPE.VERTICAL_AWNING });
        });
      } else {
        msg.payload.devices.forEach(element => registerDevice(element));
      }
      break;

    case 'wms-vb-rcv-weather-broadcast': {
      const stickCmd = msg.payload.stickCmd || '';
      const w = msg.payload.weather;
      if (isDuplicateRawMessage(stickCmd, w.snr)) break;
      if (!devices[w.snr]) registerDevice({ snr: w.snr, type: TYPE.WEATHER });
      addWindSample(w.snr, w.wind);
      maybePublishWindStats(w.snr);
      const weather = { temp: w.temp, wind: w.wind, lumen: w.lumen, rain: w.rain };
      if (shouldPublishWeather(w.snr, weather)) {
        publish(`warema/${w.snr}/illuminance/state`, w.lumen.toString());
        publish(`warema/${w.snr}/temperature/state`, w.temp.toString());
        publish(`warema/${w.snr}/rain/state`, w.rain ? 'ON' : 'OFF');
        updateWeatherCache(w.snr, weather);
      }
      break;
    }

    case 'wms-vb-blind-position-update': {
      const snr = msg.payload.snr;
      const dev = devices[snr] || {};

      if (dev.type === TYPE.LED) {
        const now = Date.now();
        if (dev.haControlUntil && now < dev.haControlUntil) return;
        if (typeof msg.payload.position !== 'undefined') {
          const brightness = normalizeWaremaBrightness(msg.payload.position);
          if (msg.payload.moving === false) {
            updateLightState(snr, brightness);
          } else {
            clearTimeout(dev.pendingLightFinalize);
            devices[snr].pendingLightFinalize = setTimeout(() => updateLightState(snr, brightness), LED_FINALIZE_MS);
          }
        }
        return;
      }

      if (typeof msg.payload.position !== 'undefined') {
        devices[snr].position = msg.payload.position;
        publish(`warema/${snr}/position`, String(msg.payload.position));
        if (msg.payload.moving === false) {
          publish(`warema/${snr}/state`, msg.payload.position === 0 ? 'open' : (msg.payload.position === 100 ? 'closed' : 'stopped'), { retain: true });
        } else {
          publish(`warema/${snr}/state`, msg.payload.position > 50 ? 'closing' : 'opening', { retain: false });
        }
      }
      if (typeof msg.payload.tilt !== 'undefined') {
        devices[snr].tilt = msg.payload.tilt;
        publish(`warema/${snr}/tilt`, String(msg.payload.tilt));
      }
      break;
    }

    default:
      log.warn('UNKNOWN MESSAGE: ' + JSON.stringify(msg, null, 2));
  }

  publish('warema/bridge/state', 'online', { retain: true });
}

/**
 * =========================
 * Weather polling (uses POLLING_INTERVAL)
 * =========================
 */
function pollWeatherData() {
  try {
    const weatherData = stickUsb.getLastWeatherBroadcast();
    if (weatherData && weatherData.snr) {
      const weather = { temp: weatherData.temp, wind: weatherData.wind, lumen: weatherData.lumen, rain: weatherData.rain };
      if (!devices[weatherData.snr]) registerDevice({ snr: weatherData.snr, type: TYPE.WEATHER });
      addWindSample(weatherData.snr, weatherData.wind);
      maybePublishWindStats(weatherData.snr);
      if (shouldPublishWeather(weatherData.snr, weather)) {
        publish(`warema/${weatherData.snr}/illuminance/state`, weatherData.lumen.toString());
        publish(`warema/${weatherData.snr}/temperature/state`, weatherData.temp.toString());
        publish(`warema/${weatherData.snr}/rain/state`, weatherData.rain ? 'ON' : 'OFF');
        updateWeatherCache(weatherData.snr, weather);
      }
    }
  } catch (error) {
    log.error('Error polling weather data: ' + error.toString());
  }
}

/**
 * =========================
 * Stick & MQTT Setup (preserves original env)
 * =========================
 */
const stickUsb = new warema(
  settingsPar.wmsSerialPort,
  settingsPar.wmsChannel,
  settingsPar.wmsPanid,
  settingsPar.wmsKey,
  {},
  callback
);

if (settingsPar.wmsPanid === 'FFFF') {
  log.info('WMS discovery mode – MQTT disabled');
  startRawCacheCleaner();
} else {
  client = mqtt.connect(mqttServer, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASSWORD,
    protocolVersion: toInt(process.env.MQTT_VERSION, 4),
    clientId: process.env.MQTT_CLIENTID || undefined,
    will: { topic: 'warema/bridge/state', payload: 'offline', retain: true, qos: MQTT_QOS }
  });

  client.on('connect', function () {
    const topics = [
      'warema/+/set',
      'warema/+/set_position',
      'warema/+/set_tilt',
      'warema/+/light/set',
      'warema/+/light/set_brightness'
    ];
    client.subscribe(topics, { qos: MQTT_QOS });
    weatherPollTimer = setInterval(pollWeatherData, pollingInterval);
    startRawCacheCleaner();
  });

  client.on('error', function (error) { log.error('MQTT Error: ' + error.toString()); });

  client.on('message', function (topic, message) {
    const parts = topic.split('/');
    const snr = parts[1];
    const command = parts.slice(2).join('/');
    const dev = devices[snr] || {};
    message = message.toString();

    switch (command) {
      case 'set': {
        const m = message.toUpperCase();
        if (m === 'CLOSE') {
          callStickSetPosition(toSnrNum(snr), 100, 0);
          publish(`warema/${snr}/state`, 'closing', { retain: false });
        } else if (m === 'CLOSETILT') {
          callStickSetPosition(toSnrNum(snr), 0, 100);
          publish(`warema/${snr}/state`, 'closing', { retain: false });
        } else if (m === 'OPEN' || m === 'OPENTILT') {
          callStickSetPosition(toSnrNum(snr), 0, 0);
          publish(`warema/${snr}/state`, 'opening', { retain: false });
        } else if (m === 'STOP') {
          try { stickUsb.vnBlindStop(toSnrNum(snr)); } catch {}
        }
        break;
      }
      case 'set_position':
        callStickSetPosition(toSnrNum(snr), toInt(message, 0));
        break;
      case 'set_tilt':
        callStickSetPosition(toSnrNum(snr), toInt(devices[snr]?.position ?? 0, 0), toInt(message, 0));
        break;
      case 'light/set':
      case 'light/set_brightness': {
        let target = 0;
        if (command === 'light/set') {
          const m = message.toUpperCase();
          if (m === 'ON') target = dev.lastBrightness ?? 100;
          else if (m === 'OFF') target = 0;
          else target = normalizeWaremaBrightness(toInt(message, 0));
        } else {
          target = normalizeWaremaBrightness(toInt(message, 0));
        }
        callStickSetPosition(toSnrNum(snr), target, 0, 1);
        devices[snr] = devices[snr] || {};
        devices[snr].haControlUntil = Date.now() + 3000;
        updateLightState(snr, target);
        break;
      }
      default:
        log.warn('Unrecognised command: ' + command);
    }
  });
}

/**
 * =========================
 * State persistence (optional)
 * =========================
 */
function saveState() {
  if (!PERSIST_STATE) return;
  try {
    const minimal = {};
    Object.keys(devices).forEach(snr => {
      const d = devices[snr];
      minimal[snr] = { type: d.type, lastBrightness: d.lastBrightness, position: d.position, tilt: d.tilt };
    });
    fs.writeFileSync(STATE_FILE, JSON.stringify(minimal, null, 2));
  } catch (e) { log.error('saveState error: ' + e); }
}

function loadState() {
  if (!PERSIST_STATE) return;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      Object.assign(devices, data);
    }
  } catch (e) { log.error('loadState error: ' + e); }
}

loadState();

/**
 * =========================
 * Graceful shutdown
 * =========================
 */
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('Shutdown initiated…');

  try {
    // MQTT offline melden
    if (client?.connected) {
      await new Promise(resolve => {
        publish('warema/bridge/state', 'offline', { retain: true });
        client.end(true, {}, resolve); // client.end kann Callback akzeptieren
      });
    }

    // Timer stoppen
    if (weatherPollTimer) {
      clearInterval(weatherPollTimer);
      weatherPollTimer = null;
    }
    if (rawCacheCleanerTimer) {
      clearInterval(rawCacheCleanerTimer);
      rawCacheCleanerTimer = null;
    }

    // Stick schließen (falls async möglich)
    if (stickUsb?.close) {
      await Promise.resolve(stickUsb.close());
    }

    // State speichern (falls saveState async wird, Promise nutzen)
    await Promise.resolve(saveState());

    log.info('Shutdown completed successfully.');
  } catch (e) {
    log.error('Shutdown error: ' + e);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
