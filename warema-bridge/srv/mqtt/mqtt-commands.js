'use strict';

const log = require('../logger');
const { client } = require('./mqtt-init');
const { devices } = require('../core/state');
const { stickUsb } = require('../hardware/stick');
const { handleHaLightCommand, updateLightState } = require('../modules/led');

client.on('connect', () => {
    client.subscribe([
        'warema/+/set',
        'warema/+/set_position',
        'warema/+/set_tilt',
        'warema/+/light/set',
        'warema/+/light/set_brightness'
    ]);
});

client.on('message', function (topic, message) {
    const parts = topic.split('/');
    const scope = parts[0];
    const device = parts[1];
    const snr = device;
    const command = parts.slice(2).join('/');

    const dev = devices[snr] || {};
    message = message.toString();

    log.debug(`Received: scope=${scope}, device=${device}, command=${command}, payload=${message}`);

    switch (command) {
        case 'set':
            switch (message) {
                case 'ON':
                case 'OFF':
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

        case 'light.set':
            break;

        case 'light/set':
        case 'light/set_brightness': {
            const target = handleHaLightCommand(client, snr, command, message);
            stickUsb.vnBlindSetPosition(snr, target, 0);
            updateLightState(client, snr, target, false);
            break;
        }

        default:
            log.warn('Unrecognised command: ' + command);
    }
});
