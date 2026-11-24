const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

function readLockfile(file) {
    try {
        const [, , port, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !password) return null;
        return { port: Number(port), password, protocol };
    } catch {
        return null;
    }
}

function requestLocalClient(credentials, method, endpoint, timeout = 3000) {
    const { port, password, protocol } = credentials;
    const transport = protocol === 'http' ? http : https;

    return new Promise((resolve, reject) => {
        const request = transport.request({
            hostname: '127.0.0.1',
            port,
            path: endpoint,
            method,
            auth: `riot:${password}`,
            // Riot uses its own certificate for these loopback endpoints.
            rejectUnauthorized: false,
            signal: AbortSignal.timeout(timeout),
        }, response => {
            response.setEncoding('utf8');
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('error', reject);
            response.on('end', () => {
                let data = body;
                try { data = JSON.parse(body); } catch { /* some endpoints return text or no body */ }
                resolve({ status: response.statusCode, data });
            });
        });
        request.on('error', reject);
        request.end();
    });
}

module.exports = { readLockfile, requestLocalClient };
