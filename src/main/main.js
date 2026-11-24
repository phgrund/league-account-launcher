const { app, dialog } = require('electron');
const state = require('./state');
const { loadConfig, saveConfig, checkDataFiles, dataFileProblemText } = require('./services/storage');
const jsonStore = require('./services/json-store');
const { resolveLolPath } = require('./services/league-path');
const { applyTheme } = require('./ipc/config');
const { registerAll } = require('./ipc/index');
const { launchFromOutside, cancelLaunch } = require('./ipc/launch');
const windows = require('./windows');

app.commandLine.appendSwitch('lang', 'en-US');

function launchArgUsername(argv) {
    const encoded = argv.find(arg => arg.startsWith('--launch-account='));
    if (encoded) {
        const selection = encoded.slice('--launch-account='.length);
        if (!/^[\w-]{1,1400}$/.test(selection)) return null;
        const username = Buffer.from(selection, 'base64url').toString('utf8');
        return username || null;
    }
    const arg = argv.find(a => a.startsWith('--launch='));
    return arg ? arg.slice('--launch='.length) : null;
}

let pendingLaunch = launchArgUsername(process.argv);
let initializingWindow = false;

function launchRequested(username) {
    if (!state.mainWindow || initializingWindow) {
        pendingLaunch = username;
        return;
    }
    return launchFromOutside(username);
}

function initialize() {
    try {
        loadConfig();
        applyTheme();
        checkDataFiles();
    } catch (error) {
        dialog.showErrorBox('League Account Launcher', `Could not read saved accounts or settings:\n${error.message}`);
    }

    const resolvedLolPath = resolveLolPath(state.config.lolPath);
    if (resolvedLolPath && resolvedLolPath !== state.config.lolPath) {
        state.config.lolPath = resolvedLolPath;
        try { saveConfig(); } catch (error) { console.error('[Boot] Could not save the detected League path:', error.message); }
    }

    registerAll();
    windows.setLaunchCallback(launchFromOutside);
    initializingWindow = true;
    windows.createMainWindow();
    windows.createTray();
    windows.updateJumpList();

    jsonStore.setNoticeListener((notice) => {
        const win = state.mainWindow;
        if (win && !win.isDestroyed()) win.webContents.send('data-file-problem', dataFileProblemText(notice));
    });
    jsonStore.markBooted();

    state.mainWindow.webContents.once('did-finish-load', () => {
        initializingWindow = false;
        const username = pendingLaunch;
        pendingLaunch = null;
        if (username) launchRequested(username)?.catch(error => console.error('[Launch] Could not open shortcut:', error.message));
    });
}

app.isQuiting = false;
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        const username = launchArgUsername(commandLine);
        if (username) return launchRequested(username)?.catch(error => console.error('[Launch] Could not open shortcut:', error.message));
        windows.showMainWindow();
    });
    app.whenReady().then(initialize).catch((error) => {
        dialog.showErrorBox('League Account Launcher', `Could not start the app:\n${error.message}`);
        app.quit();
    });
}

app.on('before-quit', () => {
    app.isQuiting = true;
    cancelLaunch();
});

module.exports = { launchArgUsername };
