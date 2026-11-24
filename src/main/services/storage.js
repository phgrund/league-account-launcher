const path = require('path');
const state = require('../state');
const { loadJson, saveJson, takeCorruptNotices } = require('./json-store');

function loadAccounts() {
    return loadJson(state.paths.accounts, [], 'accounts', Array.isArray);
}

function saveAccounts(accounts) {
    saveJson(state.paths.accounts, accounts, 'accounts');
}

// Read-modify-write on the current file. For callers that await between
// reading and writing (e.g. the LCU Riot ID link): `fn` gets the accounts as
// they are on disk now, changes them in place and returns false to skip the
// write. Everything between load and save is synchronous, so no other
// handler can interleave.
function updateAccounts(fn) {
    const accounts = loadAccounts();
    const result = fn(accounts);
    if (result === false) return false;
    saveAccounts(accounts);
    return true;
}

// Usernames are compared case-insensitively everywhere (Riot logins are).
function sameUser(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function loadConfig() {
    Object.assign(state.config, loadJson(state.paths.config, {}, 'config', (v) => v !== null && typeof v === 'object' && !Array.isArray(v)));
}

function saveConfig() {
    saveJson(state.paths.config, state.config, 'config');
}

function checkDataFiles() {
    loadAccounts();
    const notices = takeCorruptNotices();
    if (notices.length > 0) {
        const lines = notices.map(n => dataFileProblemText(n));
        throw new Error(lines.join('\n'));
    }
}

// User-facing text for a damaged or unreadable data file (boot box and the
// renderer's runtime notice share it).
function dataFileProblemText(n) {
    const name = path.basename(n.file);
    if (n.copy) return `${name} could not be read. A copy was kept as ${path.basename(n.copy)}.`;
    return `${name} could not be read (it may be locked by antivirus or OneDrive). Changes to it are not saved until it can be read again.`;
}

module.exports = { loadAccounts, saveAccounts, updateAccounts, sameUser, loadConfig, saveConfig, checkDataFiles, dataFileProblemText };
