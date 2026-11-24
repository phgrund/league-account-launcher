const { app, BrowserWindow, Tray, Menu, screen } = require('electron');
const path = require('path');
const state = require('./state');
const { accountLaunchArguments } = require('./services/account-shortcut');

let _launchCallback = null;

function setLaunchCallback(fn) {
    _launchCallback = fn;
}

// Required lazily: ipc/launch requires this module.
const launchModule = () => require('./ipc/launch');

function createMainWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    state.mainWindow = new BrowserWindow({
        width: Math.min(760, width),
        height: Math.min(600, height),
        minWidth: 500,
        minHeight: 420,
        autoHideMenuBar: true,
        show: false,
        icon: path.join(__dirname, '../renderer/assets/logo.ico'),
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            // No DevTools in installed builds: its console can call every
            // exposed IPC method, the vault gate in main notwithstanding.
            devTools: !app.isPackaged,
        },
    });

    state.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    state.mainWindow.once('ready-to-show', () => {
        // A `--launch=` of a minimize-on-launch account may already have
        // hidden the window; showing it here undid that.
        if (state.config.startMinimized || launchModule().isWindowHiddenByLaunch()) return;
        state.mainWindow.show();
    });

    state.mainWindow.on('close', (e) => {
        if (!app.isQuiting) {
            e.preventDefault();
            state.mainWindow.hide();
        }
    });

    state.mainWindow.on('closed', () => { state.mainWindow = null; });
}

function showMainWindow() {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    win.show();
    if (win.isMinimized?.()) win.restore();
    win.focus?.();
}

// Built when the menu opens, so it always matches the vault state and the
// account list without every unlock or edit having to rebuild it. While the
// vault is locked it names no accounts; the launch itself (launchFromOutside)
// shows the window, or keeps it hidden for minimize-on-launch accounts.
function buildTrayMenu() {
    let acctItems;
    if (launchModule().isVaultLocked()) {
        acctItems = [{ label: 'Unlock to see your accounts', enabled: false }];
    } else {
        const { loadAccounts } = require('./services/storage');
        acctItems = loadAccounts().slice(0, 10).map(acc => ({
            label: `${acc.label || acc.username}${acc.region ? '  ' + acc.region.toUpperCase() : ''}`,
            click: () => { if (_launchCallback) _launchCallback(acc.username); },
        }));
    }

    return Menu.buildFromTemplate([
        { label: 'League Account Launcher', enabled: false },
        { type: 'separator' },
        ...acctItems,
        { type: 'separator' },
        { label: 'Open', click: showMainWindow },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
    ]);
}

function createTray() {
    const iconPath = path.join(__dirname, '../renderer/assets/logo.ico');
    state.tray = new Tray(iconPath);
    state.tray.setToolTip('League Account Launcher');
    state.tray.on('click', showMainWindow);
    state.tray.on('double-click', showMainWindow);
    state.tray.on('right-click',  () => state.tray.popUpContextMenu(buildTrayMenu()));
}

// Windows keeps the jump list after the app exits, so it lists no accounts
// while the vault is locked; it is rebuilt on the next accounts update.
function updateJumpList() {
    if (process.platform !== 'win32') return;
    const { loadAccounts } = require('./services/storage');
    const accounts = require('./services/vault').isVaultEnabled() ? [] : loadAccounts();

    const tasks = accounts.slice(0, 5).map(acc => {
        return {
            program: process.execPath,
            arguments: accountLaunchArguments(acc.username),
            iconPath: process.execPath,
            iconIndex: 0,
            title: `Launch ${acc.label || acc.username}`,
            description: `Login to ${acc.label || acc.username}`,
        };
    });

    try {
        app.setUserTasks(tasks);
    } catch (e) {
        console.error('[JumpList] Failed to set tasks:', e.message);
    }
}

function broadcastAccountsUpdate() {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('accounts-updated');
    });
    updateJumpList();
}

module.exports = {
    createMainWindow,
    showMainWindow,
    createTray,
    buildTrayMenu,
    updateJumpList,
    broadcastAccountsUpdate,
    setLaunchCallback,
};
