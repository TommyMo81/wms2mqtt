'use strict';

const log = require('../logger');
const { envConfig } = require('../core/env');
const { weatherStats, rainState } = require('../core/state');

function updateEMA(oldV, newV, alpha) {
    if (oldV === undefined || oldV === null) return Number(newV);
    return oldV + alpha * (Number(newV) - oldV);
}

function updateWeatherEMA(client, snr, data) {
    const now = Date.now();
    let entry = weatherStats.get(snr);

    if (!entry) {
        entry = { wind: null, temp: null, lumen: null, lastPublish: 0 };
        weatherStats.set(snr, entry);
    }

    if (data.wind !== undefined) entry.wind = updateEMA(entry.wind, data.wind, envConfig.WEATHER_EMA_ALPHA);
    if (data.temp !== undefined) entry.temp = updateEMA(entry.temp, data.temp, envConfig.WEATHER_EMA_ALPHA);
    if (data.lumen !== undefined) entry.lumen = updateEMA(entry.lumen, data.lumen, envConfig.WEATHER_EMA_ALPHA);

    if (now - entry.lastPublish < envConfig.WEATHER_PUBLISH_INTERVAL_MS) return;

    if (client && client.connected) {
        if (entry.wind !== null)
            client.publish(`warema/${snr}/wind/state`, entry.wind.toFixed(1), { retain: true });
        if (entry.temp !== null)
            client.publish(`warema/${snr}/temperature/state`, entry.temp.toFixed(1), { retain: true });
        if (entry.lumen !== null)
            client.publish(`warema/${snr}/illuminance/state`, Math.round(entry.lumen).toString(), { retain: true });
    }
    entry.lastPublish = now;
    log.debug(`Published EMA weather for ${snr}`);
}

function updateRainState(client, snr, isRaining) {
    const now = Date.now();
    let entry = rainState.get(snr);

    if (!entry) {
        entry = { state: isRaining, lastChange: now };
        rainState.set(snr, entry);
        if (client && client.connected) {
            client.publish(`warema/${snr}/rain/state`, isRaining ? 'ON' : 'OFF', { retain: true });
        }
        return;
    }

    if (isRaining !== entry.state) {
        const delay = isRaining ? envConfig.RAIN_ON_DELAY : envConfig.RAIN_OFF_DELAY;
        if (now - entry.lastChange >= delay) {
            entry.state = isRaining;
            entry.lastChange = now;
            if (client && client.connected) {
                client.publish(`warema/${snr}/rain/state`, entry.state ? 'ON' : 'OFF', { retain: true });
            }
        }
    } else {
        entry.lastChange = now;
    }
}

function pollWeatherData(client, stickUsb) {
    try {
        const weatherData = stickUsb.getLastWeatherBroadcast();
        if (weatherData && weatherData.snr) {
            updateWeatherEMA(client, weatherData.snr, {
                wind: weatherData.wind,
                temp: weatherData.temp,
                lumen: weatherData.lumen
            });
            updateRainState(client, weatherData.snr, weatherData.rain);
        }
    } catch (err) {
        log.error('Error polling weather data: ' + err.toString());
    }
}

module.exports = {
    updateWeatherEMA,
    updateRainState,
    pollWeatherData
};
