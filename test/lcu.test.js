require('./helpers/fake-electron');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mockLocalHttp } = require('./helpers/local-http');
const os = require('node:os');
const path = require('node:path');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');

test('LCU requests read the current lockfile and use its loopback credentials', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-lcu-'));
    state.config.lolPath = path.join(dir, 'LeagueClient.exe');
    const lockfile = path.join(dir, 'lockfile');
    const endpoint = '/lol-login/v1/session';
    const request = () => lcu.request('GET', endpoint);
    t.after(() => fs.rmSync(dir, { force: true, recursive: true }));

    assert.equal(await request(), null, 'without lockfile');
    fs.writeFileSync(lockfile, 'LeagueClient:1:not-a-port:secret:http');
    assert.equal(await request(), null, 'with an invalid port');

    const seen = [];
    const port = mockLocalHttp(t, (req, res) => {
        seen.push(req.headers.authorization);
        res.statusCode = req.url === endpoint ? 200 : 404;
        res.end(JSON.stringify({ username: 'alice' }));
    });


    for (const password of ['first', 'second']) {
        fs.writeFileSync(lockfile, `LeagueClient:1:${port}:${password}:http`);
        assert.deepEqual(await request(), { username: 'alice' });
    }

    assert.deepEqual(seen, ['first', 'second'].map(value => `Basic ${Buffer.from(`riot:${value}`).toString('base64')}`));
    assert.equal(await lcu.request('GET', '/missing'), null);
});
