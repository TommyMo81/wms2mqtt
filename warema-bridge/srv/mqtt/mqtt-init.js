'use strict';

const mqtt = require('mqtt');
const log = require('../logger');
const { mqttServer } = require('../core/env');

let weatherInterval = null;
let weatherPoller = null;
let weatherIntervalMs = 60000;

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

let mqttReady = false;

client.on('connect', function () {
    log.info('Connected to MQTT');
    mqttReady = true;

    client.publish('warema/bridge/state', 'online', { retain: true });

    if (weatherPoller && !weatherInterval) {
        weatherInterval = setInterval(weatherPoller, weatherIntervalMs);
    }
});

client.on('close', () => {
    mqttReady = false;
    log.warn('MQTT disconnected');

    if (weatherInterval) {
        clearInterval(weatherInterval);
        weatherInterval = null;
    }
});

client.on('error', function (error) {
    log.error('MQTT Error: ' + error.toString());
});

function setWeatherPoller(fn, intervalMs) {
    weatherPoller = fn;
    if (intervalMs) weatherIntervalMs = intervalMs;

    if (mqttReady && !weatherInterval) {
        weatherInterval = setInterval(weatherPoller, weatherIntervalMs);
    }
}

module.exports = {
    client,
    setWeatherPoller,
    isMqttReady: () => mqttReady
};
