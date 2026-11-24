const fs = require('fs');
const os = require('os');
const path = require('path');
const { load: parseYaml, JSON_SCHEMA } = require('js-yaml');
const state = require('../state');
const { loadJson, saveJson } = require('./json-store');

// When "Stay signed in" is ticked, the Riot Client keeps its sign-in in
// RiotGamesPrivateSettings.yaml and signs in by itself on the next start.
// The app keeps a copy of that file
// per account, encrypted with safeStorage (Windows DPAPI), and puts the right
// one in place before it starts the Riot Client.
// The copy is as good as a password, so it never leaves this module
// unencrypted except into the Riot Client's own file, and it is not part of
// backups.
//
// Keyed by lower-cased login name, which does not change with the Riot ID.

function userKey(username) {
    return typeof username === 'string' ? username.toLowerCase() : '';
}

function settingsFilePath() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Riot Games', 'Riot Client', 'Data', 'RiotGamesPrivateSettings.yaml');
}

async function safeStorage() {
    try {
        const s = require('electron').safeStorage;
        return s && await s.isAsyncEncryptionAvailable() ? s : null;
    } catch {
        return null;
    }
}

function load() {
    return loadJson(state.paths.riotSessions, {}, 'Riot sessions', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function save(data) {
    try {
        saveJson(state.paths.riotSessions, data, 'Riot sessions');
    } catch { /* logged by saveJson already */ }
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function hasKeptSignIn(contents) {
    if (typeof contents !== 'string') return false;
    let settings;
    try {
        settings = parseYaml(contents, { schema: JSON_SCHEMA });
    } catch {
        return false;
    }

    // Current Riot clients store the kept authorization under psl, even
    // when riot-login.persist is null. Older clients used an ssid cookie.
    const authorization = settings?.psl?.authorization?.['riot-client'];
    if (isNonEmptyString(authorization?.refresh_token)) return true;

    const cookies = settings?.['riot-login']?.persist?.session?.cookies;
    return Array.isArray(cookies) && cookies.some(cookie =>
        cookie?.name === 'ssid' && isNonEmptyString(cookie.value));
}

function readSettingsFile() {
    try {
        return fs.readFileSync(settingsFilePath(), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('Could not read the Riot Client’s local settings. Try again once League is open.');
    }
}

// Saves the Riot Client's current kept sign-in for `username`. Only call this
// once the signed-in account has been checked to be that account. Returns
// true when a sign-in was saved.
async function captureSignIn(username, canSave = () => true) {
    const key = userKey(username);
    const yaml = readSettingsFile();
    if (!key || !hasKeptSignIn(yaml)) return false;
    const s = await safeStorage();
    if (!s) throw new Error('Windows encryption is unavailable. The session could not be saved.');
    const encrypted = await s.encryptStringAsync(yaml);
    if (!canSave()) return false;
    const data = load();
    data[key] = { enc: encrypted.toString('base64'), savedAt: Date.now() };
    saveJson(state.paths.riotSessions, data, 'Riot sessions');
    return true;
}

// Puts the saved sign-in of `username` in place for the next Riot Client
// start. Without one, a kept sign-in of another account is removed, so the
// client does not sign in as someone else. Call only while the Riot Client is
// closed. Returns true when a saved sign-in was put in place.
async function restoreSignIn(username, signal) {
    const file = settingsFilePath();
    const entry = load()[userKey(username)];
    if (entry?.enc) {
        try {
            const s = await safeStorage();
            if (s && !signal?.aborted) {
                const { result: yaml } = await s.decryptStringAsync(Buffer.from(entry.enc, 'base64'));
                if (signal?.aborted) return false;
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, yaml);
                return true;
            }
        } catch (e) {
            // Another Windows user or a restored profile must sign in again.
            console.warn('[Sessions] Saved sign-in could not be used:', e.message);
        }
    }
    if (!signal?.aborted && hasKeptSignIn(readSettingsFile())) {
        try { fs.rmSync(file, { force: true }); } catch (e) { console.warn('[Sessions] Could not clear the kept sign-in:', e.message); }
    }
    return false;
}

function hasSignIn(username) {
    return !!load()[userKey(username)];
}

function forgetSignIn(username) {
    const key = userKey(username);
    const data = load();
    if (!key || !(key in data)) return;
    delete data[key];
    save(data);
}

// Usernames (lower-cased) with a saved sign-in, for the account list.
function signInKeys() {
    return new Set(Object.keys(load()));
}

module.exports = {
    settingsFilePath, hasKeptSignIn, captureSignIn, restoreSignIn,
    hasSignIn, forgetSignIn, signInKeys,
};
