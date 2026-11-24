const { app, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const state = require('../state');
const { resolveLolPath } = require('./league-path');

function accountLaunchArguments(username) {
    const selection = Buffer.from(username, 'utf8').toString('base64url');
    const argument = `--launch-account=${selection}`;
    if (app.isPackaged) return argument;
    const appPath = app.getAppPath().replace(/\\+$/, '$&$&');
    return `"${appPath}" ${argument}`;
}

function accountShortcutIcon() {
    const leagueIcon = path.join(process.env.ProgramData || 'C:\\ProgramData',
        'Riot Games', 'Metadata', 'league_of_legends.live', 'league_of_legends.live.ico');
    if (fs.existsSync(leagueIcon)) return leagueIcon;
    return resolveLolPath(state.config.lolPath) ||
        (app.isPackaged ? process.execPath : path.join(__dirname, '../renderer/assets/logo.ico'));
}

async function createAccountShortcut(window, account) {
    const name = (account.label || account.username).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 80);
    const destination = await dialog.showSaveDialog(window, {
        title: 'Create League account shortcut',
        defaultPath: path.join(app.getPath('desktop'), `LoL - ${name}.lnk`),
        filters: [{ name: 'Windows shortcut', extensions: ['lnk'] }],
    });
    if (destination.canceled || !destination.filePath) return { success: false, cancelled: true };

    if (!/\.lnk$/i.test(destination.filePath)) {
        return { success: false, message: 'Choose a filename ending in .lnk.' };
    }
    const saved = shell.writeShortcutLink(destination.filePath, 'create', {
        target: process.execPath,
        cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
        args: accountLaunchArguments(account.username),
        description: 'Open League Account Launcher and play on this account',
        icon: accountShortcutIcon(),
        iconIndex: 0,
    });
    return saved ? { success: true } : { success: false, message: 'Windows could not create the shortcut.' };
}

module.exports = { accountLaunchArguments, createAccountShortcut };
