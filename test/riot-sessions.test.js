// Sign-in without typing: the Riot Client's kept sign-in ("Stay signed in")
// is saved per account, encrypted, and put back before the next start.
const fx = require('./helpers/a-fakes');
const { fakeElectron } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { mockLocalHttp } = require('./helpers/local-http');
const os = require('os');
const path = require('path');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const sessions = require('../src/main/services/riot-sessions');

// Reversible, and the ciphertext never contains the plaintext.
fakeElectron.safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptString: (s) => Buffer.from('DPAPI:' + Buffer.from(s, 'utf8').toString('hex')),
    encryptStringAsync: async (s) => fakeElectron.safeStorage.encryptString(s),
    decryptString: (buf) => {
        const t = buf.toString();
        if (!t.startsWith('DPAPI:')) throw new Error('Error while decrypting the ciphertext');
        return Buffer.from(t.slice(6), 'hex').toString('utf8');
    },
    decryptStringAsync: async (buf) => ({ result: fakeElectron.safeStorage.decryptString(buf) }),
};
const launch = require('../src/main/ipc/launch');
launch.register();

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-sessions-'));
process.env.ProgramData = path.join(sandbox, 'ProgramData');
process.env.LOCALAPPDATA = path.join(sandbox, 'LocalAppData');
const fakeLolPath = path.join(sandbox, 'League of Legends', 'LeagueClient.exe');
fs.mkdirSync(path.dirname(fakeLolPath), { recursive: true });
fs.writeFileSync(fakeLolPath, '');

const kept = (who) => `psl:
    authorization:
        riot-client: null
riot-login:
    persist:
        region: "EUW"
        session:
            cookies:
            -   domain: "auth.riotgames.com"
                hostOnly: true
                name: "ssid"
                path: "/"
                value: "ssid-of-${who}"
rso-authenticator:
    tdid:
        name: "tdid"
        value: "device"
`;
const notKept = `psl:
    authorization:
        riot-client: null
riot-login:
    persist: null
rso-authenticator:
    tdid:
        name: "tdid"
        value: "device"
`;

const currentSettings = `psl:
    authorization:
        riot-client:
            refresh_token: "fake-session-for-test"
riot-login:
    persist: null
`;

const settingsFile = () => sessions.settingsFilePath();
function writeSettings(text) {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), text);
}
const readSettings = () => (fs.existsSync(settingsFile()) ? fs.readFileSync(settingsFile(), 'utf8') : null);

function reset() {
    fs.rmSync(state.paths.riotSessions, { force: true });
    fs.rmSync(settingsFile(), { force: true });
}

test('a kept sign-in is recognized only with a persisted ssid cookie', () => {
    assert.equal(sessions.hasKeptSignIn(kept('alice')), true);
    assert.equal(sessions.hasKeptSignIn(kept('alice').replace(/\n/g, '\r\n')), true);
    assert.equal(sessions.hasKeptSignIn(notKept), false);
    assert.equal(sessions.hasKeptSignIn(kept('alice').replace('value: "ssid-of-alice"', 'value: ""')), false);
    assert.equal(sessions.hasKeptSignIn(null), false);
});

test('the current Riot format is recognized even with the old persist field null', () => {
    assert.equal(sessions.hasKeptSignIn(currentSettings), true);
    assert.equal(sessions.hasKeptSignIn(currentSettings.replace('"fake-session-for-test"', '""')), false);
    assert.equal(sessions.hasKeptSignIn(currentSettings.replace('riot-client:', 'another-client:')), false);
});

test('the saved sign-in is encrypted and comes back for the same account only', async () => {
    reset();
    writeSettings(kept('alice'));
    assert.equal(await sessions.captureSignIn('Alice'), true);
    const stored = fs.readFileSync(state.paths.riotSessions, 'utf8');
    assert.doesNotMatch(stored, /ssid-of-alice/, 'never stored in plain text');
    assert.equal(sessions.hasSignIn('alice'), true);

    // Bob has none: Alice's kept sign-in is removed so the client cannot
    // sign in as Alice when Bob is launched.
    writeSettings(kept('alice'));
    assert.equal(await sessions.restoreSignIn('bob'), false);
    assert.equal(readSettings(), null);

    assert.equal(await sessions.restoreSignIn('alice'), true);
    assert.equal(readSettings(), kept('alice'));

    sessions.forgetSignIn('ALICE');
    assert.equal(sessions.hasSignIn('alice'), false);
});

test('nothing is saved when Stay signed in was not ticked, and other settings stay', async () => {
    reset();
    writeSettings(notKept);
    assert.equal(await sessions.captureSignIn('alice'), false);
    assert.equal(sessions.hasSignIn('alice'), false);
    assert.equal(await sessions.restoreSignIn('alice'), false);
    assert.equal(readSettings(), notKept, 'a file without a kept sign-in is left alone');
});

test('a session saved with the old encryption API is still restored', async () => {
    reset();
    const enc = fakeElectron.safeStorage.encryptString(kept('alice')).toString('base64');
    fs.writeFileSync(state.paths.riotSessions, JSON.stringify({ alice: { enc, savedAt: 1 } }));

    assert.equal(await sessions.restoreSignIn('alice'), true);
    assert.equal(readSettings(), kept('alice'));
});

let win;
const lastStatus = () => win.statuses().at(-1);

// A fake Riot Client local API: `signedIn()` decides the auth answer.
async function riotClient(t, signedIn) {
    const calls = [];
    const port = mockLocalHttp(t, (req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url === '/rso-auth/v1/authorization') {
            res.statusCode = signedIn() ? 200 : 404;
        } else {
            res.statusCode = 200;
        }
        res.end('{}');
    });

    const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'lockfile'), `Riot Client:1:${port}:secret:http`);
    t.after(() => {

        fs.rmSync(path.join(lockDir, 'lockfile'), { force: true });
    });
    return calls;
}

function setup({ session = null } = {}) {
    launch.cancelLaunch();
    reset();
    fx.spawned.length = 0;
    fx.notifications.length = 0;
    fx.fakeVault.locked = false;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    state.config.lolPath = fakeLolPath;
    win = fx.fakeWindow({ visible: true });
    state.mainWindow = win;
    fx.writeAccounts([
        { username: 'alice', password: 'pw-a' },
        { username: 'bob', password: 'pw-b' },
    ]);
    lcu.connected = false;
    lcu.request = async (method, endpoint) => {
        if (!lcu.connected) return null;
        if (endpoint === '/lol-login/v1/session') return typeof session === 'function' ? session() : session;
        if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'None';
        return null;
    };
}

test('with a saved sign-in, Play signs in without typing and starts League', async (t) => {
    setup();
    writeSettings(kept('alice'));
    await sessions.captureSignIn('alice');
    writeSettings(kept('bob')); // the client was last signed in as Bob

    const calls = await riotClient(t, () => true);
    lcu.request = async (method, endpoint) => {
        if (!lcu.connected) return null;
        if (endpoint === '/lol-login/v1/session') return { username: 'alice' };
        return null;
    };
    const res = await launch.executeAccountLaunch('alice');
    assert.equal(res.success, true);
    const attemptedPlay = () => calls.some(call => /POST \/product-launcher\/v1\/products\/league_of_legends\/patchlines\/live\?clickWallMs=\d+$/.test(call));
    await fx.waitFor(attemptedPlay, 'League started through the Riot Client');
    lcu.connected = true;
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'the launch to finish', 5000);

    assert.equal(fx.loginScripts().length, 0, 'no password typed');
    assert.match(readSettings(), /ssid-of-alice/, "Alice's sign-in was put in place");
});

test('an expired saved sign-in is dropped and the user signs in through Riot', async (t) => {
    setup();
    writeSettings(kept('alice'));
    await sessions.captureSignIn('alice');
    await riotClient(t, () => false);
    const before = launch.SIGNIN_TIMEOUTS.saved;
    launch.SIGNIN_TIMEOUTS.saved = 300;
    t.after(() => { launch.SIGNIN_TIMEOUTS.saved = before; });

    await launch.executeAccountLaunch('alice');
    await fx.waitFor(() => /Session expired/.test(lastStatus()?.message), 'manual sign-in prompt', 5000);
    assert.equal(fx.loginScripts().length, 0);
    assert.equal(sessions.hasSignIn('alice'), false, 'the expired copy is forgotten');
});

test('the saved password is only submitted to the Riot helper after session fallback', async t => {
    setup();
    const client = path.join(sandbox, 'Riot Client', 'RiotClientServices.exe');
    fs.mkdirSync(path.dirname(client), { recursive: true });
    fs.writeFileSync(client, '');
    t.after(() => fs.rmSync(client, { force: true }));
    const password = 'test password ø';
    fx.writeAccounts([{
        username: 'alice',
        encryptedPassword: fakeElectron.safeStorage.encryptString(password).toString('base64'),
    }]);
    writeSettings(kept('alice'));
    await sessions.captureSignIn('alice');
    await riotClient(t, () => false);
    const originalTimeout = launch.SIGNIN_TIMEOUTS.saved;
    launch.SIGNIN_TIMEOUTS.saved = 10;
    t.after(() => {
        launch.SIGNIN_TIMEOUTS.saved = originalTimeout;
        launch.cancelLaunch();
    });

    assert.equal((await launch.executeAccountLaunch('alice')).success, true);
    assert.equal(fx.loginScripts().length, 0);
    await fx.waitFor(() => fx.loginScripts().length === 1, 'password fallback');
    const [helper] = fx.loginScripts();
    assert.ok(helper.args.every(arg => !arg.includes(password)));
    assert.deepEqual(JSON.parse(Buffer.from(helper.stdinData.trim(), 'base64').toString('utf8')), {
        username: 'alice', password,
    });
    helper.exit(2);
    await fx.waitFor(() => /fields did not get focus/.test(lastStatus()?.message), 'specific focus error');
});

test('a saved sign-in of the wrong account is never used again', async (t) => {
    setup();
    writeSettings(kept('alice'));
    await sessions.captureSignIn('alice');
    await riotClient(t, () => true);
    lcu.request = async (method, endpoint) => (lcu.connected && endpoint === '/lol-login/v1/session' ? { username: 'bob' } : null);
    await launch.executeAccountLaunch('alice');
    lcu.connected = true;
    await fx.waitFor(() => lastStatus()?.error, 'an error status', 5000);
    assert.equal(lastStatus().kind, 'wrong-account');
    assert.equal(sessions.hasSignIn('alice'), false);
});

test('Sign in yourself clears the kept sign-in, waits for the user and saves theirs', async (t) => {
    setup();
    writeSettings(kept('bob'));
    let signedIn = false;
    await riotClient(t, () => signedIn);
    lcu.request = async (method, endpoint) => (lcu.connected && endpoint === '/lol-login/v1/session' ? { username: 'alice' } : null);

    const res = await launch.executeAccountLaunch('alice', { manual: true });
    assert.equal(res.success, true);
    assert.equal(readSettings(), null, "Bob's sign-in is not reused");
    assert.match(lastStatus().message, /Stay signed in/);
    assert.equal(fx.loginScripts().length, 0, 'nothing is typed');

    writeSettings(kept('alice'));
    signedIn = true;
    lcu.connected = true;
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'the launch to finish', 5000);
    assert.equal(sessions.hasSignIn('alice'), true);
});

test('deleting an account forgets its saved sign-in', async () => {
    reset();
    fx.writeAccounts([{ username: 'alice', password: 'x' }]);
    writeSettings(kept('alice'));
    await sessions.captureSignIn('alice');
    require('../src/main/ipc/accounts').register();
    const { invoke } = require('./helpers/fake-electron');
    const accounts = await invoke('get-accounts');
    assert.equal(accounts[0].savedSignIn, true);
    await invoke('delete-account', 'alice');
    assert.equal(sessions.hasSignIn('alice'), false);
});


test('Add account saves the active League session using the detected username', async () => {
    setup({ session: { username: 'active-account' } });
    lcu.connected = true;
    writeSettings(currentSettings);
    const { invoke } = require('./helpers/fake-electron');
    assert.equal((await invoke('capture-account', { label: 'Primary' })).success, true);
    const accounts = fx.readAccounts();
    const account = accounts.find(account => account.username === 'active-account');
    assert.equal(account.label, 'Primary');
    assert.equal('password' in account, false);
    assert.equal(sessions.hasSignIn('active-account'), true);
    assert.equal(await sessions.restoreSignIn(null), false);
    assert.equal(await sessions.restoreSignIn('active-account'), true);
    assert.equal(readSettings(), currentSettings);
    assert.equal(fx.spawned.length, 0);
});

test('Add account requires an active League session kept by Riot', async () => {
    setup({ session: { username: 'active-account' } });
    const { invoke } = require('./helpers/fake-electron');
    assert.match((await invoke('capture-account', {})).message, /open League first/);
    lcu.connected = true;
    assert.match((await invoke('capture-account', {})).message, /No saved Riot session was found/);
    assert.equal(fx.readAccounts().some(account => account.username === 'active-account'), false);
});
