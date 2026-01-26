'use strict';

module.exports.settingsPar = {
    wmsChannel: parseInt(process.env.WMS_CHANNEL || '17', 10),
    wmsKey: process.env.WMS_KEY || '00112233445566778899AABBCCDDEEFF',
    wmsPanid: process.env.WMS_PAN_ID || 'FFFF',
    wmsSerialPort: process.env.WMS_SERIAL_PORT || '/dev/ttyUSB0'
};

module.exports.mqttServer = process.env.MQTT_SERVER || 'mqtt://localhost';

module.exports.envConfig = {
    ignoredDevices: process.env.IGNORED_DEVICES
        ? process.env.IGNORED_DEVICES.split(',')
        : [],
    forceDevices: process.env.FORCE_DEVICES
        ? process.env.FORCE_DEVICES.split(',')
        : [],
    devicePollingInterval: parseInt(process.env.DEVICE_POLLING_INTERVAL || '2000', 10),
    weatherPollingInterval: parseInt(process.env.WEATHER_POLLING_INTERVAL || '30000', 10),
    movingInterval: parseInt(process.env.MOVING_INTERVAL || '2000', 10),
    WEATHER_EMA_ALPHA: parseFloat(process.env.WEATHER_EMA_ALPHA || '0.2'),
    WEATHER_PUBLISH_INTERVAL_MS: parseInt(
        process.env.WEATHER_PUBLISH_INTERVAL_MS || '60000',
        10
    ),
    RAIN_ON_DELAY: parseInt(process.env.RAIN_ON_DELAY || '10000', 10),
    RAIN_OFF_DELAY: parseInt(process.env.RAIN_OFF_DELAY || '30000', 10)
};
