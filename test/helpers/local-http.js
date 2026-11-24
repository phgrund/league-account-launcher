const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function mockLocalHttp(t, handle) {
    const port = 46000;
    t.mock.method(http, 'request', (options, onResponse) => {
        assert.equal(options.hostname, '127.0.0.1');
        assert.equal(options.port, port);
        const request = new EventEmitter();
        request.end = () => queueMicrotask(() => {
            const response = new PassThrough();
            response.statusCode = 200;
            onResponse(response);
            handle({
                method: options.method,
                url: options.path,
                headers: { authorization: `Basic ${Buffer.from(options.auth).toString('base64')}` },
            }, response);
        });
        return request;
    });
    return port;
}

module.exports = { mockLocalHttp };
