'use strict';

const { devices } = require('../core/state');

function updateCoverPosition(client, snr, newPos, moving, lastPos) {
    const dev = devices[snr];
    dev.position = newPos;

    let state;
    if (moving === true) {
        state = newPos > (lastPos ?? 0) ? 'closing' : 'opening';
    } else {
        state = newPos === 0 ? 'open' : newPos === 100 ? 'closed' : 'stopped';
    }

    client.publish(`warema/${snr}/position`, String(newPos), { retain: dev.lastPosition === undefined });
    client.publish(`warema/${snr}/state`, state, { retain: dev.lastPosition === undefined });

    dev.lastPosition = newPos;
}

function updateCoverTilt(client, snr, angle) {
    const dev = devices[snr];
    dev.tilt = angle;
    client.publish(`warema/${snr}/tilt`, String(angle), { retain: true });
}

module.exports = {
    updateCoverPosition,
    updateCoverTilt
};
