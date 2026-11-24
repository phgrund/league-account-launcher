const { safeStorage } = require('electron');

const MAX_PASSWORD_LENGTH = 1024;

async function encryptPassword(password) {
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
        throw new Error('Enter a valid Riot password.');
    }
    try {
        if (process.platform === 'win32' && await safeStorage?.isAsyncEncryptionAvailable()) {
            const encrypted = await safeStorage.encryptStringAsync(password);
            if (encrypted.length > 0) return encrypted.toString('base64');
        }
    } catch {
        // Keep native errors and credential data out of the renderer.
    }
    throw new Error('Windows encryption is unavailable. The password was not saved.');
}

async function decryptPassword(encryptedPassword) {
    if (process.platform !== 'win32' || typeof encryptedPassword !== 'string' || !encryptedPassword) return null;
    try {
        const { result } = await safeStorage.decryptStringAsync(Buffer.from(encryptedPassword, 'base64'));
        return result || null;
    } catch {
        return null;
    }
}

module.exports = { encryptPassword, decryptPassword };
