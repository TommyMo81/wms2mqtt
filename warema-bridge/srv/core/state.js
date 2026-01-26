'use strict';

const fs = require('fs');

const DEVICE_CACHE_FILE = '/data/devices.json';

const devices = {};          // SNR → { type, position, tilt, lastBrightness, haControlled, haControlUntil }
const weatherStats = new Map();
const rainState = new Map();
const rawMessageCache = new Map();

const WAREMA_LED_STEPS = [100, 89, 78, 67, 56, 45, 34, 23, 12, 1];

// Load persisted device cache
function loadCache() {
    try {
        if (fs.existsSync(DEVICE_CACHE_FILE)) {
            Object.assign(devices, JSON.parse(fs.readFileSync(DEVICE_CACHE_FILE)));
            console.log('Loaded device cache');
        }
    } catch (e) {
        console.warn('Failed to load device cache:', e.toString());
    }
}

function saveCache() {
    try {
        fs.writeFileSync(DEVICE_CACHE_FILE, JSON.stringify(devices, null, 2));
    } catch (e) {
        console.warn('Failed to save device cache:', e.toString());
    }
}

loadCache();

module.exports = {
    devices,
    weatherStats,
    rainState,
    rawMessageCache,
    WAREMA_LED_STEPS,
    saveCache
};
