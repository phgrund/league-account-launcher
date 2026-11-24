const fx = require('./helpers/a-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { mockLocalHttp } = require('./helpers/local-http');
const os = require('os');
const path = require('path');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const launch = require('../src/main/ipc/launch');

launch.register();

// Keep the tests away from the machine's real Riot install records.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-launch-'));
process.env.ProgramData = path.join(sandbox, 'ProgramData');
process.env.LOCALAPPDATA = path.join(sandbox, 'LocalAppData');
const fakeLolPath = path.join(sandbox, 'League of Legends', 'LeagueClient.exe');
fs.mkdirSync(path.dirname(fakeLolPath), { recursive: true });
fs.writeFileSync(fakeLolPath, '');

let win;

function setup({ accounts, lcuConnected = false, session = null, phase = 'None', visible = true } = {}) {
    launch.cancelLaunch(); // no launch left over from a previous test
    fx.spawned.length = 0;
    fx.notifications.length = 0;
    fx.fakeVault.locked = false;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    state.config.lolPath = fakeLolPath;
    win = fx.fakeWindow({ visible });
    state.mainWindow = win;
    fx.writeAccounts(accounts || [
        { username: 'alice', password: 'pw-a' },
        { username: 'bob', password: 'pw-b' },
    ]);
    lcu.connected = lcuConnected;
    lcu.request = async (method, endpoint) => {
        if (!lcu.connected) return null;
        if (endpoint === '/lol-login/v1/session') return typeof session === 'function' ? session() : session;
        if (endpoint === '/lol-gameflow/v1/gameflow-phase') return phase;
        return null;
    };
}

async function startLaunch(username, opts) {
    const result = await launch.executeAccountLaunch(username, opts);
    assert.equal(result.success, true, JSON.stringify(result));
}

const lastStatus = () => win.statuses().at(-1);

test('a second launch while one runs is refused, from the window and from the tray', async () => {
    setup();
    let killChild;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) killChild = child; });

    const first = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => killChild, 'the kill command');

    assert.deepEqual(
        { ...(await launch.executeAccountLaunch('bob')), message: undefined },
        { success: false, busy: true, message: undefined });
    const fromTray = await launch.launchFromOutside('bob');
    assert.equal(fromTray.busy, true);

    killChild.exit(0);
    assert.equal((await first).success, true);
    assert.equal(fx.spawned.filter(child => !child.isPowerShellCommand).length, 1);
    assert.equal(fx.loginScripts().length, 0);
});

test('cancel while the clients are being closed stops the launch before any credentials', async () => {
    setup();
    let killChild;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) killChild = child; });

    const pending = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => killChild, 'the kill command');
    assert.deepEqual(launch.cancelLaunch(), { success: true });
    assert.equal(lastStatus(), null, 'cancel clears the overlay');
    const sentAfterCancel = win.sent.length;

    killChild.exit(0);
    assert.equal((await pending).cancelled, true);
    assert.equal(fx.loginScripts().length, 0, 'no login script after cancel');
    assert.equal(fx.spawned.filter(c => c.command !== 'powershell.exe').length, 0, 'no Riot Client started');
    assert.equal(win.sent.length, sentAfterCancel, 'nothing sent after cancel');

    // And the next launch is not blocked by the cancelled one.
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    await startLaunch('bob');
});

test('cancel while waiting for Riot clears progress without submitting any credentials', async () => {
    setup();
    await startLaunch('alice');
    assert.match(lastStatus().message, /Sign in in the Riot Client/);
    assert.deepEqual(await fx.invoke('cancel-launch'), { success: true });
    assert.equal(lastStatus(), null);
    assert.equal(fx.loginScripts().length, 0);
    assert.equal(launch.isLaunchInProgress(), false);
});

test('a Riot Client that fails to start ends the launch with an error', async () => {
    setup();
    await startLaunch('alice');
    const rc = fx.spawned.find(c => c.command !== 'powershell.exe');
    rc.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    assert.equal(lastStatus().error, true);
    assert.match(lastStatus().message, /EACCES/);
    assert.equal(launch.isLaunchInProgress(), false);
});

test('all client processes are closed and gone before the Riot Client starts', async () => {
    setup();
    let killChild;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) killChild = child; });
    const pending = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => killChild, 'the kill command');
    const command = killChild.args.at(-1);
    for (const name of ['LeagueClient', 'LeagueClientUxRender', 'RiotClientServices', 'Riot Client', 'RiotClientUx']) {
        assert.ok(command.includes(`'${name}'`), `kills ${name}`);
    }
    assert.doesNotMatch(command, /valorant/i);
    assert.match(command, /for \(\$i = 0/, 'waits for the processes to exit');
    assert.equal(killChild.options.windowsHide, true);
    await fx.tick();
    assert.equal(fx.spawned.length, 1, 'nothing else starts before the kill finished');
    killChild.exit(0);
    await pending;
    assert.ok(fx.spawned.some(c => c.command !== 'powershell.exe'), 'Riot Client started after');
});

test('a failed shutdown does not start another client or type credentials', async () => {
    setup();
    fx.setSpawnBehavior(child => { if (child.isPowerShellCommand) child.exit(1); });
    const result = await launch.executeAccountLaunch('alice');
    assert.equal(result.success, false);
    assert.match(result.message, /Could not close/);
    assert.equal(fx.spawned.length, 1);
    assert.equal(launch.isLaunchInProgress(), false);
});

test('launching another account during a game asks first', async () => {
    setup({ lcuConnected: true, session: { username: 'bob' }, phase: 'InProgress' });
    const res = await launch.executeAccountLaunch('alice');
    assert.equal(res.needsConfirm, true);
    assert.equal(fx.spawned.length, 0, 'nothing killed');
    assert.equal(launch.isLaunchInProgress(), false);
    await startLaunch('alice', { confirmed: true });
});

test('while the vault is locked nothing launches, the tray path shows the lock screen', async () => {
    setup({ visible: false });
    fx.fakeVault.locked = true;
    assert.deepEqual(await launch.executeAccountLaunch('alice'),
        { success: false, locked: true, message: 'Vault is locked' });
    const res = await launch.launchFromOutside('alice');
    assert.equal(res.locked, true);
    assert.equal(win.visible, true);
    assert.equal(fx.spawned.length, 0);
    assert.equal(win.sent.length, 0);
});

test('a tray launch of a minimize-on-launch account does not show the window', async () => {
    setup({ visible: false, accounts: [{ username: 'alice', password: 'x', minimizeOnLaunch: true }] });
    await launch.launchFromOutside('alice');
    assert.equal(win.counts.show, 0);
});

test('a tray launch that cannot start shows the error', async () => {
    setup({ visible: false });
    const res = await launch.launchFromOutside('nobody');
    assert.equal(res.success, false);
    assert.equal(win.visible, true);
    assert.equal(lastStatus().error, true, 'the overlay shows the error');
    assert.equal(fx.notifications.length, 1, 'the window was hidden: notify too');
    assert.match(fx.notifications[0].body, /not found/);
});

test('verifyLoggedInAccount compares usernames case-insensitively', () => {
    assert.deepEqual(launch.verifyLoggedInAccount('Alice', { username: 'alice' }), { ok: true });
    assert.deepEqual(launch.verifyLoggedInAccount('alice', { username: 'bob' }), { ok: false, actual: 'bob' });
    assert.deepEqual(launch.verifyLoggedInAccount('alice', null), { ok: null });
});

// lastUsed was saved from the list loaded before the client checks (up to
// 3 s of awaits), undoing edits and bringing back deleted accounts.
test('recording lastUsed keeps changes made while the launch checked the client', async () => {
    setup({
        lcuConnected: true,
        session: () => {
            // Meanwhile: bob gets a new label, carol is deleted.
            fx.writeAccounts([
                { username: 'alice', password: 'pw-a' },
                { username: 'bob', password: 'pw-b', label: 'edited meanwhile' },
            ]);
            return { username: 'someone-else' };
        },
        accounts: [
            { username: 'alice', password: 'pw-a' },
            { username: 'bob', password: 'pw-b' },
            { username: 'carol', password: 'pw-c' },
        ],
    });
    await startLaunch('alice');
    const saved = fx.readAccounts();
    assert.deepEqual(saved.map(a => a.username), ['alice', 'bob'], 'carol stays deleted');
    assert.equal(saved.find(a => a.username === 'bob').label, 'edited meanwhile');
    assert.ok(saved.find(a => a.username === 'alice').lastUsed > 0);
    launch.cancelLaunch();
});

// After the sign-in the Riot Client stayed on its home page: League is now
// started through its API as soon as it reports a signed-in player.
test('League is started through the Riot Client once the sign-in is done, not before', async (t) => {
    setup();
    let signedIn = false;
    const launches = [];
    const port = mockLocalHttp(t, (req, res) => {
        if (req.url === '/rso-auth/v1/authorization') {
            res.statusCode = signedIn ? 200 : 404;
        } else if (req.method === 'POST' && /^\/product-launcher\/v1\/products\/league_of_legends\/patchlines\/live\?clickWallMs=\d+$/.test(req.url)) {
            launches.push(req.headers.authorization);
            res.statusCode = 204;
        } else {
            res.statusCode = 404;
        }
        res.end(res.statusCode === 204 ? '' : '{}');
    });

    const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'lockfile'), `Riot Client:1:${port}:secret:http`);
    t.after(() => fs.rmSync(path.join(lockDir, 'lockfile'), { force: true }));

    await startLaunch('alice');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(launches.length, 0, 'nothing while a code or captcha may still be open');
    signedIn = true;
    await fx.waitFor(() => launches.length === 1, 'League started through the Riot Client', 4000);
    assert.equal(launches[0], `Basic ${Buffer.from('riot:secret').toString('base64')}`);
    await fx.waitFor(() => /Waiting for League to open/.test(lastStatus()?.message || ''), 'the accepted Play status');
});

test('an account that is already signed in still counts as used', async () => {
    setup({ lcuConnected: true, session: { username: 'alice' } });
    const res = await launch.executeAccountLaunch('alice');
    assert.equal(res.success, true);
    assert.ok(fx.readAccounts().find((a) => a.username === 'alice').lastUsed > 0);
});

test('a cold launch asks Riot to start League directly and reuses the resulting session', async t => {
    const client = path.join(sandbox, 'Riot Client', 'RiotClientServices.exe');
    fs.mkdirSync(path.dirname(client), { recursive: true });
    fs.writeFileSync(client, '');
    t.after(() => fs.rmSync(client, { force: true }));

    setup({ session: { username: 'alice' } });
    fx.setSpawnBehavior(child => {
        if (child.isPowerShellCommand || child.args.includes('-Minimize')) child.exit(0);
        if (child.command === client) lcu.connected = true;
    });
    const calls = [];
    const port = mockLocalHttp(t, (req, res) => {
        calls.push(req.method);
        res.end('{}');
    });
    const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockfile = path.join(lockDir, 'lockfile');
    fs.writeFileSync(lockfile, `Riot Client:1:${port}:secret:http`);
    t.after(() => fs.rmSync(lockfile, { force: true }));

    await startLaunch('alice');
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'direct launch');
    assert.deepEqual(fx.spawned.find(child => child.command === client)?.args, [
        '--launch-product=league_of_legends', '--launch-patchline=live', '--allow-direct-launch',
    ]);
    assert.equal(calls.includes('POST'), false);
    assert.equal(fx.spawned.some(child => child.args.includes('-PlayLeague')), false);
});

test('HTTP 464 falls back to Play in the existing Riot session', async t => {
    const client = path.join(sandbox, 'Riot Client', 'RiotClientServices.exe');
    fs.mkdirSync(path.dirname(client), { recursive: true });
    fs.writeFileSync(client, '');
    t.after(() => fs.rmSync(client, { force: true }));

    const cases = [
        { description: 'opens League when Play is available', clicked: true, kind: 'done', message: /Signed in/ },
        { description: 'accepts a League session that appears after Play disappears', clicked: false, kind: 'done', message: /Signed in/ },
        { description: 'reports when Play and the League session are unavailable', clicked: false, kind: 'needs-action', message: /enabled League Play button/ },
    ];
    for (const { description, clicked, kind, message } of cases) {
        await t.test(description, { timeout: 4500 }, async subtest => {
            setup({ session: { username: 'alice' } });
            fx.setSpawnBehavior(child => {
                if (child.args.includes('-PlayLeague')) {
                    lcu.connected = clicked;
                    child.exit(clicked ? 0 : 1);
                }
                if (child.args.includes('-Minimize')) child.exit(0);
            });
            const calls = [];
            const port = mockLocalHttp(subtest, (req, res) => {
                calls.push(req.url);
                if (req.url === '/riot-client-auth/v1/userinfo') {
                    res.end(JSON.stringify({ preferred_username: 'ALICE' }));
                    return;
                }
                res.statusCode = 464;
                res.end('{}');
            });
            const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
            fs.mkdirSync(lockDir, { recursive: true });
            const lockfile = path.join(lockDir, 'lockfile');
            fs.writeFileSync(lockfile, `Riot Client:1:${port}:secret:http`);
            subtest.after(() => fs.rmSync(lockfile, { force: true }));

            await startLaunch('alice');
            if (!clicked) {
                await fx.waitFor(() => /Waiting for League to open/.test(lastStatus()?.message), 'the session check after Play');
                if (kind === 'done') {
                    lcu.connected = true;
                } else {
                    subtest.mock.timers.enable({ apis: ['Date'], now: Date.now() });
                    subtest.mock.timers.tick(26000);
                }
            }
            await fx.waitFor(() => lastStatus()?.kind === kind, description);
            assert.match(lastStatus().message, message);
            assert.equal(win.statuses().filter(status => status?.error).length, kind === 'done' ? 0 : 1);
            assert.equal(fx.spawned.filter(child => child.args.includes('-PlayLeague')).length, 1);
            assert.equal(fx.loginScripts().length, 0);
            assert.ok(fx.spawned.every(child => child.command === 'powershell.exe' && !child.isPowerShellCommand));
            assert.equal(calls.filter(url => url.includes('clickWallMs=')).length, 1);
        });
    }
});
