'use strict';

/**
 * Main entry for Warema Home Assistant Add-on
 * Modular Version (Variante B) — v2 (FB steps define lastBrightness)
 */

const { settingsPar } = require('./core/env');

if (settingsPar.wmsPanid === 'FFFF') {
    console.log('Warema PAN discovery mode active – MQTT will not connect.');
    // Discovery: initialize stick & callbacks only, no MQTT
    require('./hardware/stick');
    require('./hardware/stick-callbacks');
} else {
    // Normal mode
    require('./mqtt/mqtt-init');
    require('./hardware/stick');
    require('./hardware/stick-callbacks');
    require('./mqtt/mqtt-commands');
}

console.log('Warema Add-on (Modular Version B v2) started.');
