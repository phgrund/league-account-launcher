const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { loadAccounts, saveAccounts, sameUser } = require('../services/storage');
const { encryptExport, decryptExport, decryptExportV1, backupVersion } = require('../services/encryption');
const { encryptPassword } = require('../services/account-password');
const { createAccountShortcut } = require('../services/account-shortcut');
const { broadcastAccountsUpdate } = require('../windows');
const vault = require('../services/vault');
const state = require('../state');
const riotSessions = require('../services/riot-sessions');

// Account identity fields supported by existing backups.
const ACCOUNT_FIELDS = {
    label: { type: 'string', def: '', max: 200 },
    riotId: { type: 'string', def: '', max: 100 },
    region: { type: 'string', def: '', max: 16 },
    minimizeOnLaunch: { type: 'boolean', def: false },
};
const MAX_USERNAME = 256;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const MIN_PASSPHRASE = 8;
const PENDING_IMPORT_TTL_MS = 10 * 60 * 1000;

function validUsername(u) {
    return typeof u === 'string' && u.trim().length > 0 && u.length <= MAX_USERNAME;
}

// Picks the known fields out of `data`. With `base` (an existing record),
// missing or null fields keep the base value; without it they get defaults.
// Returns { ok: true, fields } or { ok: false, message }.
function pickFields(data, base) {
    const fields = {};
    for (const [key, spec] of Object.entries(ACCOUNT_FIELDS)) {
        const v = data[key];
        if (v === undefined || v === null) {
            fields[key] = base ? (base[key] ?? spec.def) : spec.def;
            continue;
        }
        if (typeof v !== spec.type) return { ok: false, message: `Invalid value for ${key}` };
        if (spec.type === 'string' && v.length > spec.max) return { ok: false, message: `${key} is too long` };
        fields[key] = v;
    }
    return { ok: true, fields };
}

function errorResult(e) {
    return { success: false, message: e?.message || String(e) };
}

// Writes via a temp file and rename so a failed export never leaves a
// half-written backup under the chosen name.
function writeFileAtomic(filePath, text) {
    const tmp = `${filePath}.tmp`;
    try {
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, filePath);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
    }
}

// A backup chosen in the file dialog that still needs its passphrase. The
// contents are kept (not the path) so the file cannot change in between.
let _pendingImport = null;

function register() {
    ipcMain.handle('get-accounts', () => {
        if (vault.isVaultLocked()) return [];
        const signIns = riotSessions.signInKeys();
        return loadAccounts().map(account => ({
            username: account.username,
            label: account.label,
            riotId: account.riotId,
            region: account.region,
            minimizeOnLaunch: account.minimizeOnLaunch === true,
            savedSignIn: signIns.has(String(account.username).toLowerCase()),
            hasSavedPassword: !!account.encryptedPassword,
        }));
    });

    ipcMain.handle('create-account-shortcut', async (event, username) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (!validUsername(username)) return { success: false, message: 'Account not found' };
        try {
            const account = loadAccounts().find(candidate => sameUser(candidate.username, username));
            if (!account) return { success: false, message: 'Account not found' };
            return await createAccountShortcut(state.mainWindow, account);
        } catch (error) {
            return errorResult(error);
        }
    });

    ipcMain.handle('add-account', async (event, data) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (!validUsername(data?.username)) return { success: false, message: 'Enter your Riot login username.' };
        const picked = pickFields(data);
        if (!picked.ok) return { success: false, message: picked.message };

        try {
            const encryptedPassword = await encryptPassword(data.password);
            if (vault.isVaultLocked()) return vault.lockedResult();
            const accounts = loadAccounts();
            if (accounts.some(account => sameUser(account.username, data.username))) {
                return { success: false, message: 'This account is already saved. Use Edit to update its password.' };
            }
            saveAccounts([...accounts, { username: data.username, ...picked.fields, encryptedPassword }]);
        } catch (error) {
            return errorResult(error);
        }
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('capture-account', async (event, data) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (!data || typeof data !== 'object') return { success: false, message: 'Invalid account data' };
        const picked = pickFields(data);
        if (!picked.ok) return { success: false, message: picked.message };
        const { isLaunchInProgress } = require('./launch');
        const busy = { success: false, message: 'Wait for the current account switch to finish.' };
        if (isLaunchInProgress()) return busy;

        try {
            const session = await require('../lcu').request('GET', '/lol-login/v1/session');
            if (vault.isVaultLocked()) return vault.lockedResult();
            if (isLaunchInProgress()) return busy;
            const username = session?.username;
            if (!validUsername(username)) {
                return { success: false, message: 'Sign in through the Riot Client, tick "Stay signed in", and open League first.' };
            }

            const wasSaved = riotSessions.hasSignIn(username);
            const captured = await riotSessions.captureSignIn(username, () => !vault.isVaultLocked() && !isLaunchInProgress());
            if (vault.isVaultLocked()) return vault.lockedResult();
            if (isLaunchInProgress()) return busy;
            if (!captured) {
                return { success: false, message: 'No saved Riot session was found. Sign in with "Stay signed in" ticked, then try again with League open.' };
            }
            const accounts = loadAccounts();
            const existing = accounts.find(account => sameUser(account.username, username));
            if (!existing) {
                try {
                    saveAccounts([...accounts, { username, ...picked.fields }]);
                } catch (error) {
                    if (!wasSaved) riotSessions.forgetSignIn(username);
                    throw error;
                }
            }
        } catch (error) {
            return errorResult(error);
        }
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('update-account', async (event, data) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (!data || typeof data !== 'object' || typeof data.username !== 'string') return { success: false, message: 'Invalid account data' };
        try {
            const encryptedPassword = data.password === undefined || data.password === ''
                ? null
                : await encryptPassword(data.password);
            if (vault.isVaultLocked()) return vault.lockedResult();
            const accounts = loadAccounts();
            const index    = accounts.findIndex(a => sameUser(a.username, data.username));
            if (index === -1) return { success: false, message: 'Account not found' };

            const old = accounts[index];
            const picked = pickFields(data, old);
            if (!picked.ok) return { success: false, message: picked.message };
            const updated = { ...old, ...picked.fields };
            if (encryptedPassword) {
                updated.encryptedPassword = encryptedPassword;
                delete updated.password;
            }
            accounts[index] = updated;
            saveAccounts(accounts);
        } catch (e) {
            return errorResult(e);
        }
        broadcastAccountsUpdate();

        return { success: true };
    });

    ipcMain.handle('delete-account', (event, username) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (typeof username !== 'string') return { success: false, message: 'Account not found' };
        try {
            const accounts = loadAccounts();
            const index = accounts.findIndex(a => sameUser(a.username, username));
            if (index === -1) return { success: false, message: 'Account not found' };
            const [removed] = accounts.splice(index, 1);
            saveAccounts(accounts);
            riotSessions.forgetSignIn(removed.username);
        } catch (e) {
            return errorResult(e);
        }
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('get-vault-state', () => vault.getVaultState());

    ipcMain.handle('unlock-vault', async (event, password) => {
        const wasLocked = vault.isVaultLocked();
        const res = await vault.unlockVault(password);
        if (res.success && wasLocked) {
            broadcastAccountsUpdate();
            const { resumeExternalLaunch } = require('./launch');
            resumeExternalLaunch()?.catch(error => console.error('[Launch] Could not resume shortcut:', error.message));
        }
        return res;
    });

    // Enabling or disabling changes what the tray and jump list may show.
    ipcMain.handle('set-vault-password', async (event, payload) => {
        const res = await vault.setVaultPassword(payload);
        if (res.success) broadcastAccountsUpdate();
        return res;
    });

    ipcMain.handle('disable-vault', async (event, current) => {
        const res = await vault.disableVault(current);
        if (res.success) broadcastAccountsUpdate();
        return res;
    });

    // usernames: export only these (Select in the account list), else all.
    ipcMain.handle('export-accounts', async (event, passphrase, usernames = null) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        // Not trimmed: the passphrase is used exactly as typed.
        if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
            return { success: false, message: `The passphrase needs at least ${MIN_PASSPHRASE} characters` };
        }
        try {
            const result = await dialog.showSaveDialog(state.mainWindow, {
                title: 'Export Accounts',
                defaultPath: 'league-accounts.lalbackup',
                filters: [{ name: 'League Account Backup', extensions: ['lalbackup'] }],
            });
            if (result.canceled || !result.filePath) return { success: false, canceled: true };

            const only = Array.isArray(usernames) ? new Set(usernames.filter((u) => typeof u === 'string').map((u) => u.toLowerCase())) : null;
            const accounts = loadAccounts().filter((a) => !only || only.has(a.username.toLowerCase()));
            const exportData = {
                version: 1,
                exported: Date.now(),
                accounts: accounts.map(account => {
                    const picked = pickFields(account);
                    return { username: account.username, ...(picked.ok ? picked.fields : {}) };
                }),
            };
            writeFileAtomic(result.filePath, await encryptExport(exportData, passphrase));
            return { success: true, count: accounts.length };
        } catch (e) {
            return errorResult(e);
        }
    });

    ipcMain.handle('import-accounts', async (event, opts) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        const passphrase = opts && typeof opts === 'object' && typeof opts.passphrase === 'string' ? opts.passphrase : undefined;
        try {
            // A passphrase for a backup that is no longer pending (expired after
            // PENDING_IMPORT_TTL_MS): say so instead of opening a new dialog and
            // then reporting "wrong passphrase" for the other file.
            if (passphrase !== undefined && (!_pendingImport || Date.now() - _pendingImport.at > PENDING_IMPORT_TTL_MS)) {
                _pendingImport = null;
                return { success: false, expired: true, message: 'The chosen backup is no longer open. Choose the file again.' };
            }
            // A call without a passphrase starts over with a new file.
            if (_pendingImport && passphrase === undefined) {
                _pendingImport = null;
            }

            let text;
            if (_pendingImport) {
                text = _pendingImport.text;
            } else {
                const result = await dialog.showOpenDialog(state.mainWindow, {
                    title: 'Import Accounts',
                    filters: [{ name: 'League Account Backup', extensions: ['lalbackup', 'llem'] }],
                    properties: ['openFile'],
                });
                if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
                const file = result.filePaths[0];
                if (fs.statSync(file).size > MAX_BACKUP_BYTES) return { success: false, message: 'This file is too large to be a backup' };
                text = fs.readFileSync(file, 'utf8').trim();
            }

            let data;
            const version = backupVersion(text);
            if (version === 'v1') {
                data = decryptExportV1(text);
            } else if (version === 'v2') {
                if (!passphrase) {
                    _pendingImport = { text, at: Date.now() };
                    return { success: false, needsPassphrase: true };
                }
                const r = await decryptExport(text, passphrase);
                if (!r.ok && r.reason === 'wrong-passphrase') {
                    _pendingImport = { text, at: Date.now() };
                    return { success: false, needsPassphrase: true, wrongPassphrase: true };
                }
                data = r.ok ? r.data : null;
            }
            _pendingImport = null;

            if (!data || typeof data !== 'object' || !Array.isArray(data.accounts)) {
                return { success: false, message: 'Invalid or corrupted backup file' };
            }
            if (typeof data.version === 'number' && data.version > 1) {
                return { success: false, message: 'This backup was made by a newer version of the app' };
            }
            return importRecords(data.accounts);
        } catch (e) {
            return errorResult(e);
        }
    });
}

function importRecords(records) {
    const existing = loadAccounts();
    let added = 0, duplicates = 0, invalid = 0;
    for (const acc of records) {
        if (!acc || typeof acc !== 'object' || !validUsername(acc.username)) { invalid++; continue; }
        const picked = pickFields(acc);
        if (!picked.ok) { invalid++; continue; }
        if (existing.some(e => sameUser(e.username, acc.username))) { duplicates++; continue; }
        existing.push({ username: acc.username, ...picked.fields });
        added++;
    }
    if (added > 0) {
        saveAccounts(existing);
        broadcastAccountsUpdate();
    }
    return { success: true, added, skipped: duplicates + invalid, duplicates, invalid };
}

module.exports = { register };
