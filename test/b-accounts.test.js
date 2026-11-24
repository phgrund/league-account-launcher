const { invoke, fakeElectron, safe, userData, file, writeJson, readJson, legacy } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const encryption = require('../src/main/services/encryption');
require('../src/main/ipc/accounts').register();

const PASS = 'correct horse battery';
const backupPath = path.join(userData, 'backup.lalbackup');

function chooseSave(filePath) {
    fakeElectron.dialog.showSaveDialog = async () => ({ canceled: false, filePath });
}

let openCalls = 0;
function chooseOpen(filePath) {
    fakeElectron.dialog.showOpenDialog = async () => { openCalls++; return { canceled: false, filePaths: [filePath] }; };
}

test.beforeEach(() => {
    state.config.vaultEnabled = false;
    openCalls = 0;
    writeJson('accounts.json', []);
    fs.rmSync(backupPath, { force: true });
});


test('backup v2 round-trips only with its passphrase, and each export has its own salt', async () => {
    const data = { version: 1, accounts: [{ username: '\u03bb', password: 'plain-text-pw' }] };
    const a = await encryption.encryptExport(data, PASS);
    const b = await encryption.encryptExport(data, PASS);
    assert.equal(JSON.parse(a).format, 'league-account-backup');
    assert.notEqual(JSON.parse(a).kdf.salt, JSON.parse(b).kdf.salt);
    assert.equal(a.includes('plain-text-pw'), false);
    assert.deepEqual((await encryption.decryptExport(a, PASS)).data, data);
    assert.deepEqual(await encryption.decryptExport(a, 'wrong passphrase'), { ok: false, reason: 'wrong-passphrase' });

    const tampered = JSON.parse(a);
    tampered.kdf.N = 2 ** 30;
    assert.deepEqual(await encryption.decryptExport(JSON.stringify(tampered), PASS), { ok: false, reason: 'invalid' });
});

test('export needs a passphrase of at least 8 characters, not trimmed', async () => {
    chooseSave(backupPath);
    assert.equal((await invoke('export-accounts')).success, false);
    assert.equal((await invoke('export-accounts', 'short')).success, false);
    assert.equal((await invoke('export-accounts', '   abc   ')).success, true);
    assert.equal(fs.existsSync(backupPath), true);
});

test('export then import with the passphrase restores accounts; old passwords are left out', async () => {
    writeJson('accounts.json', [
        { username: 'main', password: 's3cret-pw', encryptedPassword: 'local-only', label: 'Main', notes: 'n', _cachedStats: { tier: 'Gold' }, lastUsed: 5 },
    ]);
    chooseSave(backupPath);
    const exp = await invoke('export-accounts', PASS);
    assert.deepEqual(exp, { success: true, count: 1 });
    const backup = await encryption.decryptExport(fs.readFileSync(backupPath, 'utf8'), PASS);
    assert.equal(backup.ok, true);
    assert.equal('password' in backup.data.accounts[0], false);
    assert.equal('encryptedPassword' in backup.data.accounts[0], false);

    writeJson('accounts.json', []);
    chooseOpen(backupPath);
    const first = await invoke('import-accounts');
    assert.deepEqual(first, { success: false, needsPassphrase: true });

    const wrong = await invoke('import-accounts', { passphrase: 'not the passphrase' });
    assert.deepEqual(wrong, { success: false, needsPassphrase: true, wrongPassphrase: true });

    const ok = await invoke('import-accounts', { passphrase: PASS });
    assert.equal(ok.success, true);
    assert.equal(ok.added, 1);
    assert.equal(openCalls, 1, 'the pending file is reused, the dialog opens once');

    const [acc] = readJson('accounts.json');
    assert.equal(acc.username, 'main');
    assert.equal(acc.label, 'Main');
    assert.equal('password' in acc, false);
    assert.equal('_cachedStats' in acc, false);
    assert.equal('lastUsed' in acc, false);
});

test('old fixed-key backups still import without a passphrase', async () => {
    fs.writeFileSync(backupPath, legacy.exportV1({ version: 1, accounts: [{ username: 'old', password: 'pw1', region: 'euw' }] }));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, true);
    assert.equal(res.added, 1);
    assert.equal('password' in readJson('accounts.json')[0], false);
});

test('import validates entries, copies only known fields and reports skips', async () => {
    writeJson('accounts.json', [{ username: 'Existing', password: 'x' }]);
    fs.writeFileSync(backupPath, legacy.exportV1({ version: 1, accounts: [
        { username: 123, password: 'x' },
        { username: 'a', label: {} },
        null,
        { username: 'existing', password: 'dup' },
        { username: 'good', password: 'b', _cachedStats: { tier: '<img src=x>' }, honorFlagged: true, extra: 1 },
    ] }));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, true);
    assert.equal(res.added, 1);
    assert.equal(res.skipped, 4);
    assert.equal(res.duplicates, 1);
    assert.equal(res.invalid, 3);
    const good = readJson('accounts.json').find(a => a.username === 'good');
    assert.deepEqual(Object.keys(good).filter(k => k.startsWith('_') || k === 'extra' || k === 'honorFlagged'), []);
});

test('a backup from a newer version is refused', async () => {
    fs.writeFileSync(backupPath, legacy.exportV1({ version: 2, accounts: [] }));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, false);
    assert.match(res.message, /newer version/);
});

test('a huge file is not read', async () => {
    fs.writeFileSync(backupPath, Buffer.alloc(6 * 1024 * 1024, 0x61));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, false);
    assert.match(res.message, /too large/);
});

test('an export that cannot be written reports the error', async () => {
    chooseSave(path.join(userData, 'no-such-dir', 'x.llem'));
    const res = await invoke('export-accounts', PASS);
    assert.equal(res.success, false);
    assert.ok(res.message);
});

test('usernames match case-insensitively for updates and deletes', async () => {
    writeJson('accounts.json', [
        { username: 'Player1', password: 'one' },
        { username: 'Second', password: 'two' },
    ]);
    assert.equal((await invoke('update-account', { username: 'player1', label: 'L' })).success, true);
    assert.equal(readJson('accounts.json')[0].label, 'L');
    assert.equal(readJson('accounts.json')[0].username, 'Player1');
    assert.equal((await invoke('delete-account', 'player1')).success, true);
    assert.deepEqual(readJson('accounts.json').map(a => a.username), ['Second']);
});

test('account data sent to the renderer omits passwords and retired fields', async () => {
    writeJson('accounts.json', [{
        username: 'Main', label: 'Primary', password: 'x',
        appearOffline: true, autoSkinRandom: true, _cachedStats: { tier: 'Gold' },
    }]);
    const [account] = await invoke('get-accounts');
    assert.equal(account.label, 'Primary');
    assert.equal(account.savedSignIn, false);
    for (const key of ['password', 'appearOffline', 'autoSkinRandom', '_cachedStats']) {
        assert.equal(key in account, false, key);
    }
    assert.equal((await invoke('delete-account', 'ghost')).success, false);
});

test('a saved Riot password is encrypted locally and stays out of account IPC results', async () => {
    const password = 'example password';
    const result = await invoke('add-account', { username: 'local', password });
    assert.equal(result.success, true);
    const [saved] = readJson('accounts.json');
    assert.equal('password' in saved, false);
    assert.equal(saved.encryptedPassword.includes(password), false);
    const { result: decrypted } = await fakeElectron.safeStorage.decryptStringAsync(Buffer.from(saved.encryptedPassword, 'base64'));
    assert.equal(decrypted, password);
    const [account] = await invoke('get-accounts');
    assert.equal(account.hasSavedPassword, true);
    assert.equal('encryptedPassword' in account, false);
});

test('replacing a Riot password requires Windows encryption and removes the old format on success', async t => {
    writeJson('accounts.json', [{ username: 'local', password: 'legacy-encrypted' }]);
    safe.available = false;
    t.after(() => { safe.available = true; });
    assert.equal((await invoke('update-account', { username: 'local', password: 'new secret' })).success, false);
    assert.equal(readJson('accounts.json')[0].password, 'legacy-encrypted');

    safe.available = true;
    assert.equal((await invoke('update-account', { username: 'local', password: 'new secret' })).success, true);
    assert.equal('password' in readJson('accounts.json')[0], false);
    assert.equal((await invoke('get-accounts'))[0].hasSavedPassword, true);
});

test('export can be limited to the selected accounts', async () => {
    writeJson('accounts.json', [
        { username: 'one', password: 'a-pw' },
        { username: 'two', password: 'b-pw' },
        { username: 'three', password: 'c-pw' },
    ]);
    chooseSave(backupPath);
    const res = await invoke('export-accounts', PASS, ['TWO', 'three']);
    assert.equal(res.count, 2);
    const { data } = await encryption.decryptExport(fs.readFileSync(backupPath, 'utf8'), PASS);
    assert.deepEqual(data.accounts.map((a) => a.username), ['two', 'three']);
});
