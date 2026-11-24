const { ipcMain, dialog, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const state = require('../state');
const { saveConfig } = require('../services/storage');
const { isVaultEnabled } = require('../services/vault');

const THEMES = ['system', 'light', 'dark'];
const ALLOWED_CONFIG_KEYS = new Map([
    ['lolPath', isLeagueClientPath],
    ['theme', value => THEMES.includes(value)],
    ['startMinimized', value => typeof value === 'boolean'],
]);

function isLeagueClientPath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.basename(value).toLowerCase() !== 'leagueclient.exe') {
        return false;
    }
    try {
        return fs.statSync(value).isFile();
    } catch {
        return false;
    }
}

function applyTheme() {
    nativeTheme.themeSource = THEMES.includes(state.config.theme) ? state.config.theme : 'system';
}

function register() {
    ipcMain.handle('get-config', () => ({
        lolPath: state.config.lolPath,
        lolPathFound: isLeagueClientPath(state.config.lolPath),
        theme: nativeTheme.themeSource,
        startMinimized: state.config.startMinimized === true,
        vaultEnabled: isVaultEnabled(),
    }));

    ipcMain.handle('choose-league-path', async () => {
        const result = await dialog.showOpenDialog(state.mainWindow, {
            title: 'Find LeagueClient.exe',
            filters: [{ name: 'Applications', extensions: ['exe'] }],
            properties: ['openFile'],
        });
        const selected = result.filePaths?.[0];
        if (result.canceled || !selected) return { success: false, canceled: true };
        if (!isLeagueClientPath(selected)) return { success: false, message: 'Select LeagueClient.exe.' };
        return { success: true, path: selected };
    });

    ipcMain.handle('set-config', (event, settings) => {
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            return { success: false, message: 'Invalid settings.' };
        }
        const previous = {};
        for (const [key, value] of Object.entries(settings)) {
            const validate = ALLOWED_CONFIG_KEYS.get(key);
            if (!validate?.(value)) return { success: false, message: `Invalid value for ${key}.` };
            previous[key] = state.config[key];
        }
        Object.assign(state.config, settings);
        try {
            saveConfig();
        } catch (error) {
            Object.assign(state.config, previous);
            return { success: false, message: `Could not save settings: ${error.message}` };
        }
        applyTheme();
        return { success: true };
    });
}

module.exports = { register, applyTheme };
