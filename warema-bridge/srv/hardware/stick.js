'use strict';

const warema = require('../warema-wms-venetian-blinds');
const log = require('../logger');
const { settingsPar, envConfig } = require('../core/env');

let cbHandlers = { onMessage: null };

function internalCallback(err, msg) {
    if (err) log.error(err);
    if (cbHandlers.onMessage) {
        try {
            cbHandlers.onMessage(err, msg);
        } catch (e) {
            log.error('Error in callback handler: ' + e.toString());
        }
    }
}

const stickUsb = new warema(
    settingsPar.wmsSerialPort,
    settingsPar.wmsChannel,
    settingsPar.wmsPanid,
    settingsPar.wmsKey,
    {},
    internalCallback
);

function setCallbackHandlers(handlers) {
    cbHandlers = handlers || cbHandlers;
}

function initStick() {
    log.info('Initializing WMS stick...');
    stickUsb.setPosUpdInterval(envConfig.devicePollingInterval);
    stickUsb.setWatchMovingBlindsInterval(envConfig.movingInterval);
    stickUsb.scanDevices({ autoAssignBlinds: false });
}

function scanDevices() {
    stickUsb.scanDevices({ autoAssignBlinds: false });
}

function vnBlindsList() {
    try { return stickUsb.vnBlindsList(); } catch { return []; }
}

module.exports = {
    stickUsb,
    setCallbackHandlers,
    initStick,
    scanDevices,
    vnBlindsList
};
