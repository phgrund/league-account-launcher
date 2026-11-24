const path = require('node:path');
const state = require('./state');
const { readLockfile, requestLocalClient } = require('./services/local-client');

async function request(method, endpoint, options = {}) {
    if (typeof state.config.lolPath !== 'string' || !state.config.lolPath) return null;
    const credentials = readLockfile(path.join(path.dirname(state.config.lolPath), 'lockfile'));
    if (!credentials) return null;

    try {
        const { status, data } = await requestLocalClient(credentials, method, endpoint, options.timeout);
        return status >= 200 && status < 300 ? data : null;
    } catch {
        return null;
    }
}

module.exports = { request };
