'use strict';

const log = require('../logger');
const { devices } = require('../core/state');
const { envConfig } = require('../core/env');
const { stickUsb, setCallbackHandlers, initStick, scanDevices, vnBlindsList } = require('./stick');
const { client, setWeatherPoller } = require('../mqtt/mqtt-init');

const { updateCoverPosition, updateCoverTilt } = require('../modules/covers');
const { handleStickBrightnessStep, handleStickBrightnessFinal } = require('../modules/led');
const { updateWeatherEMA, updateRainState, pollWeatherData } = require('../modules/weather');

// Start weather polling via MQTT module (runs when MQTT is connected)
setWeatherPoller(() => pollWeatherData(client, stickUsb), envConfig.weatherPollingInterval);

function publishInitialState(snr, type) {
    if (!client || !client.connected) return;
    const dev = devices[snr];
    if (!dev) return;

    switch (type) {
        case '28': { // LED
            const brightness = dev.lastBrightness ?? 0;
            const isOn = brightness > 0;
            client.publish(`warema/${snr}/light/brightness`, String(brightness), { retain: true });
            client.publish(`warema/${snr}/light/state`, isOn ? 'ON' : 'OFF', { retain: true });
            break;
        }
        case '21':
        case '25':
        case '2A':
        case '20':
        case '24': { // Cover
            if (dev.position !== undefined) {
                client.publish(`warema/${snr}/position`, '' + dev.position, { retain: true });
                const state = dev.position === 0 ? 'open' : dev.position === 100 ? 'closed' : 'stopped';
                client.publish(`warema/${snr}/state`, state, { retain: true });
            }
            if (dev.tilt !== undefined) {
                client.publish(`warema/${snr}/tilt`, '' + dev.tilt, { retain: true });
            }
            break;
        }
        case '63': {
            // Weather is published periodically
            break;
        }
    }
}

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
        manufacturer: 'Warema',
        name: element.snr
    };

    if (process.env.IGNORED_DEVICES && process.env.IGNORED_DEVICES.split(',').includes(element.snr.toString())) {
        log.info('Ignoring device ' + element.snr + ' (type ' + element.type + ')');
        return;
    }

    let payload;
    let model;
    let topicForDiscovery;

    switch (element.type) {
        case '63': { // Weather
            model = 'Weather station pro';
            const payloadBase = { ...base_payload, device: { ...base_device, model } };

            client.publish(`homeassistant/sensor/${element.snr}/illuminance/config`, JSON.stringify({
                ...payloadBase,
                state_topic: `warema/${element.snr}/illuminance/state`,
                device_class: 'illuminance',
                unique_id: `${element.snr}_illuminance`,
                unit_of_measurement: 'lx',
                state_class: 'measurement'
            }), { retain: true });

            client.publish(`homeassistant/sensor/${element.snr}/temperature/config`, JSON.stringify({
                ...payloadBase,
                state_topic: `warema/${element.snr}/temperature/state`,
                device_class: 'temperature',
                unique_id: `${element.snr}_temperature`,
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 1
            }), { retain: true });

            client.publish(`homeassistant/sensor/${element.snr}/wind/config`, JSON.stringify({
                ...payloadBase,
                state_topic: `warema/${element.snr}/wind/state`,
                device_class: 'wind_speed',
                unique_id: `${element.snr}_wind`,
                unit_of_measurement: 'm/s',
                state_class: 'measurement'
            }), { retain: true });

            client.publish(`homeassistant/binary_sensor/${element.snr}/rain/config`, JSON.stringify({
                ...payloadBase,
                state_topic: `warema/${element.snr}/rain/state`,
                device_class: 'moisture',
                unique_id: `${element.snr}_rain`
            }), { retain: true });

            if (client && client.connected) client.publish(availability_topic, 'online', { retain: true });

            devices[element.snr] = { type: element.type };
            log.info('Registered Weather Station ' + element.snr);
            return;
        }

        case '28': { // LED
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
                supported_color_modes: ['brightness'],
                color_mode: 'brightness',
                payload_on: 'ON',
                payload_off: 'OFF',
                optimistic: true,
                unique_id: `${element.snr}_light`,
                default_entity_id: `light.${element.snr}`
            };
            topicForDiscovery = `homeassistant/light/${element.snr}/${element.snr}/config`;

            devices[element.snr] = {
                type: element.type,
                lastBrightness: devices[element.snr]?.lastBrightness ?? 0,
                position: 0,
                haControlled: false,
                haControlUntil: 0
            };
            break;
        }

        case '21':
        case '25':
        case '2A':
        case '20':
        case '24': { // Cover
            model =
                element.type === '21' ? 'Actuator UP' :
                element.type === '25' ? 'Vertical awning' :
                element.type === '2A' ? 'Slat roof' :
                element.type === '20' ? 'Plug receiver' :
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

            if (['21', '2A'].includes(element.type)) {
                payload.tilt_status_topic = `warema/${element.snr}/tilt`;
                payload.tilt_command_topic = `warema/${element.snr}/set_tilt`;
                payload.tilt_min = -100;
                payload.tilt_max = 100;
            }

            topicForDiscovery = `homeassistant/cover/${element.snr}/${element.snr}/config`;

            devices[element.snr] = {
                type: element.type,
                position: undefined,
                tilt: undefined,
                lastPosition: undefined
            };
            break;
        }

        default:
            log.warn('Unrecognized device type: ' + element.type);
            return;
    }

    if (element.type !== '63') {
        stickUsb.vnBlindAdd(parseInt(element.snr, 10), element.snr.toString());
    }

    if (client && client.connected) {
        client.publish(availability_topic, 'online', { retain: true });
        const dev = devices[element.snr];
        if (['21', '25', '2A', '20', '24'].includes(dev.type)) {
            try {
                const pos = stickUsb.vnBlindGetPosition(parseInt(element.snr, 10));
                if (pos !== undefined && pos !== null) {
                    dev.position = pos;
                    dev.lastPosition = pos;
                }
            } catch (err) {
                log.warn('Could not get initial position from stick for ' + element.snr + ': ' + err.toString());
            }
        }
        publishInitialState(element.snr, element.type);
    }

    if (topicForDiscovery && payload) {
        client.publish(topicForDiscovery, JSON.stringify(payload), { retain: true });
    }
}

setCallbackHandlers({
    onMessage: (err, msg) => {
        if (err) log.error(err);
        if (!msg) return;

        log.debug('Callback received topic: ' + msg.topic);

        switch (msg.topic) {
            case 'wms-vb-init-completion': {
                log.info('Warema stick ready');
                initStick();
                scanDevices();
                if (client && client.connected) {
                    client.publish('warema/bridge/state', 'online', { retain: true });
                    for (const snr of Object.keys(devices)) {
                        client.publish(`warema/${snr}/availability`, 'online', { retain: true });
                    }
                }
                break;
            }
            case 'wms-vb-scanned-devices': {
                log.debug('Scanned devices:
' + JSON.stringify(msg.payload, null, 2));
                const forced = (process.env.FORCE_DEVICES || '').split(',').map(s => s.trim()).filter(Boolean);
                if (forced.length) {
                    forced.forEach(deviceString => {
                        const [snr, type] = deviceString.split(':');
                        registerDevice({ snr, type: type || '25' });
                    });
                } else {
                    msg.payload.devices.forEach(element => registerDevice(element));
                }
                log.debug('Registered devices:
' + JSON.stringify(vnBlindsList(), null, 2));
                break;
            }
            case 'wms-vb-rcv-weather-broadcast': {
                const w = msg.payload.weather;
                updateWeatherEMA(client, w.snr, { wind: w.wind, temp: w.temp, lumen: w.lumen });
                updateRainState(client, w.snr, w.rain);
                break;
            }
            case 'wms-vb-blind-position-update': {
                const snr = msg.payload.snr;
                const dev = devices[snr] || {};
                if (!dev) break;

                // LED (Typ 28)
                if (dev.type === '28') {
                    if (typeof msg.payload.position !== 'undefined') {
                        // Every FB step (moving true/false) updates lastBrightness immediately if HA not active
                        handleStickBrightnessStep(client, snr, msg.payload.position);

                        // Final confirmation: ensure commit + retain + end of HA window
                        if (msg.payload.moving === false) {
                            handleStickBrightnessFinal(client, snr, msg.payload.position);
                        }
                    }
                    return;
                }

                // Cover / Markise / Lamellendach
                if (typeof msg.payload.position !== 'undefined') {
                    updateCoverPosition(client, snr, msg.payload.position, msg.payload.moving === true, dev.lastPosition);
                }

                if (typeof msg.payload.angle !== 'undefined') {
                    updateCoverTilt(client, snr, msg.payload.angle);
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
});

module.exports = {};
