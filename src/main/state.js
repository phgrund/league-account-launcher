const { app } = require('electron');
const fs = require('node:fs');
const path = require('path');

const profileFiles = ['accounts.json', 'config.json', 'riot-sessions.json'];
// Keep the full Electron profile in place for existing installs.
const previousProfile = path.join(app.getPath('appData'), 'leaguelogin');
const currentProfile = app.getPath('userData');
if (!profileFiles.some(file => fs.existsSync(path.join(currentProfile, file))) &&
    profileFiles.some(file => fs.existsSync(path.join(previousProfile, file)))) {
    app.setPath('userData', previousProfile);
}
const appData = app.getPath('userData');

module.exports = {
    mainWindow: null,
    tray: null,
    vaultUnlocked: false,
    config: {
        lolPath: 'C:\\Riot Games\\League of Legends\\LeagueClient.exe',
        theme: 'system',
        startMinimized: false,
        vaultEnabled: false,
    },
    paths: {
        accounts: path.join(appData, 'accounts.json'),
        config: path.join(appData, 'config.json'),
        riotSessions: path.join(appData, 'riot-sessions.json'),
    },
};
