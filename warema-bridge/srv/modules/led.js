'use strict';

const { devices, WAREMA_LED_STEPS, saveCache } = require('../core/state');

/**
 * Normalize brightness to Warema step-resolution.
 */
function normalizeBrightness(v) {
    if (v <= 0) return 0;

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

/**
 * Update LED state in MQTT + internal structure.
 * v = brightness 0–100 AFTER normalization
 * retain = whether MQTT should retain the value
 */
function updateLightState(client, snr, brightness, retain = false) {
    const v = Math.max(0, Math.min(100, Number(brightness)));

    if (!devices[snr]) devices[snr] = {};
    const dev = devices[snr];

    dev.type = '28';
    dev.position = v;

    // lastBrightness nur pflegen, wenn real >0
    if (v > 0) {
        dev.lastBrightness = v;
        saveCache();
    }

    if (client && client.connected) {
        client.publish(`warema/${snr}/light/brightness`, String(v), { retain });
        client.publish(`warema/${snr}/light/state`, v > 0 ? 'ON' : 'OFF', { retain });
    }
}

/**
 * Handle HA commands (set / set_brightness)
 */
function handleHaLightCommand(snr, command, payload) {
    if (!devices[snr]) devices[snr] = {};
    const dev = devices[snr];

    // HA-Steuerung ist nur ein zeitlich begrenzter Hint
    dev.haControlled = true;
    dev.haControlUntil = Date.now() + 3000;

    let target = 0;

    if (command === 'light/set') {
        const up = payload.toUpperCase();
        if (up === 'ON') {
            target = dev.lastBrightness ?? 100;
        } else if (up === 'OFF') {
            target = 0;
        }
    }

    if (command === 'light/set_brightness') {
        const haValue = Math.max(0, Math.min(100, parseInt(payload, 10)));
        target = normalizeBrightness(haValue);
    }

    return target;
}

/**
 * FB-Step (moving=true/false)
 * → IMMER akzeptieren
 */
function handleStickBrightnessStep(client, snr, rawValue) {
    const normalized = normalizeBrightness(rawValue);
    updateLightState(client, snr, normalized, false);
}

/**
 * FB-Final (moving=false)
 */
function handleStickBrightnessFinal(client, snr, rawValue) {
    const normalized = normalizeBrightness(rawValue);
    updateLightState(client, snr, normalized, false);

    if (devices[snr]) {
        devices[snr].haControlled = false;
    }
}

module.exports = {
    normalizeBrightness,
    updateLightState,
    handleHaLightCommand,
    handleStickBrightnessStep,
    handleStickBrightnessFinal
};
