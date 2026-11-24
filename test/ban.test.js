// Issue #12: the remaining suspension time of a banned account. The Riot
// Client reports the ban at sign-in; it can also be entered by hand.
const fx = require('./helpers/a-fakes');
const { fakeElectron } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { mockLocalHttp } = require('./helpers/local-http');
const os = require('os');
const path = require('path');
const state = require('../src/main/state');
const status = require('../src/main/services/account-status');
const sessions = require('../src/main/services/riot-sessions');
const launch = require('../src/main/ipc/launch');
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16);

test('a time ban and a permanent ban are read from the user info, other restrictions are not', () => {
    const until = NOW + 30 * HOUR;
    const info = { sub: 'x', ban: { restrictions: [
        { type: 'TEXT_CHAT_RESTRICTION', scope: 'lol', dat: { expirationMillis: NOW + 99 * HOUR } },
        { type: 'TIME_BAN', scope: 'valorant', dat: { expirationMillis: NOW + 500 * HOUR } },
        { type: 'TIME_BAN', scope: 'lol', dat: { expirationMillis: until } },
    ] } };
    assert.deepEqual(status.parseBan(info), { permanent: false, until });
    assert.deepEqual(status.parseBan(JSON.stringify(info)), { permanent: false, until }, 'as a JSON string');
    assert.deepEqual(status.parseBan({ userInfo: JSON.stringify(info) }), { permanent: false, until }, 'wrapped');
    const jwt = ['e30', Buffer.from(JSON.stringify(info)).toString('base64url'), 'sig'].join('.');
    assert.deepEqual(status.parseBan(jwt), { permanent: false, until }, 'as a token');
    assert.deepEqual(status.parseBan({ ban: { restrictions: [{ type: 'PERMANENT_BAN', scope: 'riot' }] } }), { permanent: true, until: null });
    assert.equal(status.parseBan({ ban: { restrictions: [] } }), null, 'not banned');
    assert.equal(status.parseBan({ sub: 'x' }), null, 'no ban block: not banned');
    assert.equal(status.parseBan(null), undefined, 'nothing read: unknown');
});

fakeElectron.safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => Buffer.from('DPAPI:' + Buffer.from(s, 'utf8').toString('hex')),
    decryptStringAsync: async (buf) => ({ result: Buffer.from(buf.toString().slice(6), 'hex').toString('utf8') }),
};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ban-'));
process.env.ProgramData = path.join(sandbox, 'ProgramData');
process.env.LOCALAPPDATA = path.join(sandbox, 'LocalAppData');
const fakeLolPath = path.join(sandbox, 'League of Legends', 'LeagueClient.exe');
fs.mkdirSync(path.dirname(fakeLolPath), { recursive: true });
fs.writeFileSync(fakeLolPath, '');

test('signing in to a suspended account reports the ban and stops the launch', async (t) => {
    launch.cancelLaunch();
    fx.spawned.length = 0;
    fx.fakeVault.locked = false;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    state.config.lolPath = fakeLolPath;
    const win = fx.fakeWindow({ visible: true });
    state.mainWindow = win;
    fx.writeAccounts([{ username: 'alice', password: 'pw' }]);

    // A saved sign-in, so the launch goes straight to the signed-in check.
    const file = sessions.settingsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'riot-login:\n    persist:\n        session:\n            cookies:\n            -   name: "ssid"\n                value: "s"\n');
    await sessions.captureSignIn('alice');

    const until = Date.now() + 30 * HOUR;
    const calls = [];
    const port = mockLocalHttp(t, (req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url === '/riot-client-auth/v1/userinfo') {
            res.end(JSON.stringify({ ban: { restrictions: [{ type: 'TIME_BAN', scope: 'lol', dat: { expirationMillis: until } }] } }));
        } else {
            res.end('{}');
        }
    });

    const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'lockfile'), `Riot Client:1:${port}:secret:http`);


    await launch.executeAccountLaunch('alice');
    await fx.waitFor(() => win.statuses().at(-1)?.error, 'an error status', 5000);
    const last = win.statuses().at(-1);
    assert.equal(last.kind, 'banned');
    assert.match(last.message, /suspended until/);
    assert.ok(!calls.some(c => c.includes('product-launcher')), 'League is not started');
});
