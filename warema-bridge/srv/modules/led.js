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
    const now = Date.now();

    if (!devices[snr]) devices[snr] = {};
    const dev = devices[snr];
    dev.type = '28';
    dev.position = v;

    const haActive = dev.haControlled && dev.haControlUntil && now < dev.haControlUntil;

    // Variante A + "last device wins":
    // - Während HA-Fahrt KEIN lastBrightness-Update hier
    // - Final (moving=false) wird lastBrightness in handleStickBrightnessFinal gesetzt
    if (v > 0 && !haActive) {
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
function handleHaLightCommand(client, snr, command, payload) {
    const dev = devices[snr] || {};

    dev.haControlled = true;
    dev.haControlUntil = Date.now() + 3000; // 3s window to detect final confirmation

    let target = 0;

    if (command === 'light/set') {
        const up = payload.toUpperCase();
        if (up === 'ON') {
            target = dev.lastBrightness ?? 100; // last device wins -> use latest persisted value
            updateLightState(client, snr, target, true); // UI update
        } else if (up === 'OFF') {
            target = 0;
        }
    } else if (command === 'light/set_brightness') {
        const haValue = Math.max(0, Math.min(100, parseInt(payload, 10)));
        target = normalizeBrightness(haValue);
    }

    return target; // caller sends to stick
}

/**
 * FB step (may be moving=true): if HA not active, every step writes lastBrightness (>0)
 */
function handleStickBrightnessStep(client, snr, rawValue) {
    const dev = devices[snr] || {};
    const now = Date.now();

    const haActive = dev.haControlled && dev.haControlUntil && now < dev.haControlUntil;
    if (haActive) return; // ignore FB while HA drives

    const normalized = normalizeBrightness(rawValue);
    if (normalized > 0) {
        dev.lastBrightness = normalized; // immediate step update
        saveCache();
    }

    // reflect to HA without retain (intermediate)
    updateLightState(client, snr, normalized, false);
}

/**
 * Final confirmation (moving=false): ALWAYS set lastBrightness if >0
 * This ensures: last device (HA or FB) wins.
 */
function handleStickBrightnessFinal(client, snr, rawValue) {
    const dev = devices[snr] || {};
    const normalized = normalizeBrightness(rawValue);

    if (normalized > 0) {
        dev.lastBrightness = normalized; // commit final value regardless of HA
        saveCache();
    }

    updateLightState(client, snr, normalized, true);
    dev.haControlled = false; // end HA window if it was HA
}

module.exports = {
    normalizeBrightness,
    updateLightState,
    handleHaLightCommand,
    handleStickBrightnessStep,
    handleStickBrightnessFinal
};
