const { invoke, fakeElectron, userData, writeJson } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const storage = require('../src/main/services/storage');
require('../src/main/ipc/config').register();

test('legacy settings load, and get-config only exposes launcher settings', async () => {
    writeJson('config.json', { theme: 'dark', staySignedIn: false, riotApiKey: 'old-key', game: 'valorant', autoAccept: true });
    storage.loadConfig();
    require('../src/main/ipc/config').applyTheme();

    const settings = await invoke('get-config');
    assert.equal(settings.theme, 'dark');
    assert.equal('staySignedIn' in settings, false);
    for (const key of ['riotApiKey', 'game', 'autoAccept']) assert.equal(key in settings, false, key);
});

test('unknown settings are rejected without applying other changes', async () => {
    state.config.startMinimized = true;
    const res = await invoke('set-config', { startMinimized: false, vaultEnabled: false, checkUpdatesOnStartup: true });
    assert.equal(res.success, false);
    assert.equal(state.config.startMinimized, true);
});

test('lolPath must point to an existing LeagueClient.exe', async () => {
    const before = state.config.lolPath;
    const exe = path.join(userData, 'cmd.exe');
    fs.writeFileSync(exe, '');
    assert.equal((await invoke('set-config', { lolPath: exe })).success, false);
    assert.equal((await invoke('set-config', { lolPath: path.join(userData, 'missing', 'LeagueClient.exe') })).success, false);
    assert.equal((await invoke('set-config', { lolPath: 'LeagueClient.exe' })).success, false);
    assert.equal(state.config.lolPath, before);

    const client = path.join(userData, 'LeagueClient.exe');
    fs.writeFileSync(client, '');
    assert.equal((await invoke('set-config', { lolPath: client })).success, true);
    assert.equal(state.config.lolPath, client);
});

test('the installation picker only returns LeagueClient.exe', async () => {
    const wrong = path.join(userData, 'Another.exe');
    fs.writeFileSync(wrong, '');
    fakeElectron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wrong] });
    assert.equal((await invoke('choose-league-path')).success, false);

    const client = path.join(userData, 'LeagueClient.exe');
    fakeElectron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [client] });
    assert.deepEqual(await invoke('choose-league-path'), { success: true, path: client });

    fakeElectron.dialog.showOpenDialog = async () => ({ canceled: true });
    assert.deepEqual(await invoke('choose-league-path'), { success: false, canceled: true });
});

test('a failed save reports the error and keeps the previous settings', async (t) => {
    state.config.startMinimized = false;
    t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
    const res = await invoke('set-config', { startMinimized: true });
    assert.equal(res.success, false);
    assert.match(res.message, /Could not save settings/);
    assert.equal(state.config.startMinimized, false);
});
