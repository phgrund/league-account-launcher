const crypto = require('crypto');
const ALGORITHM = 'aes-256-cbc';

// Older .llem backups used a fixed key. Keep reading their account metadata.
let _exportKey = null;
const exportKey = () => _exportKey || (_exportKey = crypto.scryptSync('lost-league-export-v1', 'export-salt-ll', 32));

function decryptExportV1(text) {
    try {
        if (!text.startsWith('llem:')) return null;
        const raw = text.slice(5);
        const sep = raw.indexOf(':');
        const iv  = Buffer.from(raw.slice(0, sep), 'hex');
        const enc = Buffer.from(raw.slice(sep + 1), 'hex');
        const d = crypto.createDecipheriv(ALGORITHM, exportKey(), iv);
        return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString());
    } catch {
        return null;
    }
}

// Version 2: the key comes from a passphrase the user enters at export
// (scrypt with a random salt), the data is sealed with AES-256-GCM so a wrong
// passphrase or a modified file is detected instead of decrypting to garbage.
const BACKUP_FORMAT  = 'league-account-backup';
const LEGACY_BACKUP_FORMAT = 'lost-league-backup';
const BACKUP_AAD     = Buffer.from(`${BACKUP_FORMAT}:2`);
const BACKUP_SCRYPT  = { N: 32768, r: 8, p: 1 };
const SCRYPT_MAXMEM  = 128 * 1024 * 1024;

function scryptAsync(passphrase, salt, params) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(passphrase, salt, 32, { ...params, maxmem: SCRYPT_MAXMEM }, (err, key) => {
            if (err) reject(err); else resolve(key);
        });
    });
}

async function encryptExport(obj, passphrase) {
    if (typeof passphrase !== 'string' || !passphrase) throw new Error('A passphrase is required');
    const salt   = crypto.randomBytes(16);
    const iv     = crypto.randomBytes(12);
    const key    = await scryptAsync(passphrase, salt, BACKUP_SCRYPT);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(BACKUP_AAD);
    const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return JSON.stringify({
        format:  BACKUP_FORMAT,
        version: 2,
        kdf:     { name: 'scrypt', ...BACKUP_SCRYPT, salt: salt.toString('base64') },
        cipher:  { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
        data:    enc.toString('base64'),
    });
}

function isVersionTwoBackup(backup) {
    return backup?.version === 2 &&
        (backup.format === BACKUP_FORMAT || backup.format === LEGACY_BACKUP_FORMAT);
}

// 'v1' | 'v2' | null for anything else.
function backupVersion(text) {
    if (typeof text !== 'string') return null;
    if (text.startsWith('llem:')) return 'v1';
    try {
        const o = JSON.parse(text);
        if (isVersionTwoBackup(o)) return 'v2';
    } catch { /* not JSON */ }
    return null;
}

function validScryptParams(kdf) {
    // Bounded so a crafted file cannot make the import burn gigabytes of memory.
    const { N, r, p } = kdf || {};
    return Number.isInteger(N) && N >= 16384 && N <= 1048576 && (N & (N - 1)) === 0 &&
        Number.isInteger(r) && r >= 1 && r <= 16 &&
        Number.isInteger(p) && p >= 1 && p <= 4 &&
        128 * N * r * p <= SCRYPT_MAXMEM / 2;
}

// Resolves { ok: true, data } or { ok: false, reason: 'invalid' | 'wrong-passphrase' }.
async function decryptExport(text, passphrase) {
    let o;
    try { o = JSON.parse(text); } catch { return { ok: false, reason: 'invalid' }; }
    if (!isVersionTwoBackup(o) || o.kdf?.name !== 'scrypt' ||
        o.cipher?.name !== 'aes-256-gcm' || !validScryptParams(o.kdf) ||
        typeof o.kdf.salt !== 'string' || typeof o.cipher.iv !== 'string' ||
        typeof o.cipher.tag !== 'string' || typeof o.data !== 'string') {
        return { ok: false, reason: 'invalid' };
    }
    const salt = Buffer.from(o.kdf.salt, 'base64');
    const iv   = Buffer.from(o.cipher.iv, 'base64');
    const tag  = Buffer.from(o.cipher.tag, 'base64');
    if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) return { ok: false, reason: 'invalid' };

    const key = await scryptAsync(String(passphrase ?? ''), salt, { N: o.kdf.N, r: o.kdf.r, p: o.kdf.p });
    let plain;
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAAD(Buffer.from(`${o.format}:2`));
        d.setAuthTag(tag);
        plain = Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
    } catch {
        // GCM cannot tell a wrong passphrase from a modified file.
        return { ok: false, reason: 'wrong-passphrase' };
    }
    try {
        return { ok: true, data: JSON.parse(plain) };
    } catch {
        return { ok: false, reason: 'invalid' };
    }
}

module.exports = {
    encryptExport, decryptExport, decryptExportV1, backupVersion,
};
