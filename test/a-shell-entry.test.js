// Tray, jump list, second instance (`--launch=`), and quitting: the ways into the app that do not go through the renderer.
const fx = require('./helpers/a-fakes');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fakeElectron } = fx;

const appHandlers = {};
const userTasks = [];
Object.assign(fakeElectron.app, {
    requestSingleInstanceLock: () => true,
    on: (event, fn) => { appHandlers[event] = fn; },
    whenReady: () => new Promise(() => {}), // boot itself is not under test
    quit: () => {},
    setUserTasks: (tasks) => { userTasks.push(tasks); },
});
fakeElectron.Menu.buildFromTemplate = (template) => ({ template });
fakeElectron.Tray = class extends EventEmitter {
    setToolTip() {}
    popUpContextMenu(menu) { this.popped = menu; }
};
fakeElectron.BrowserWindow = class extends EventEmitter {
    static getAllWindows() { return []; }
    constructor() {
        super();
        this.shown = 0;
        this.webContents = new EventEmitter();
        this.webContents.send = () => {};
    }
    loadFile() {}
    show() { this.shown++; }
    hide() {}
    isDestroyed() { return false; }
    isVisible() { return this.shown > 0; }
};
const state = require('../src/main/state');
const windows = require('../src/main/windows');
const launch = require('../src/main/ipc/launch');
const { launchArgUsername } = require('../src/main/main');
const { createAccountShortcut } = require('../src/main/services/account-shortcut');

function setup({ locked = false, accounts } = {}) {
    launch.cancelLaunch();
    fx.spawned.length = 0;
    fx.fakeVault.locked = locked;
    fx.writeAccounts(accounts || [{ username: 'alice', label: 'Main', password: 'x' }]);
    state.mainWindow = fx.fakeWindow({ visible: false });
}

function trayMenu() {
    windows.createTray();
    state.tray.emit('right-click');
    return state.tray.popped.template;
}

test('the tray lists no accounts while the vault is locked', () => {
    setup({ locked: true });
    const labels = trayMenu().map(i => i.label).filter(Boolean);
    assert.ok(!labels.some(l => l.includes('Main')));
    assert.ok(labels.includes('Unlock to see your accounts'));
});

test('the tray menu is built when opened, with the current accounts', () => {
    setup();
    const launched = [];
    windows.setLaunchCallback((u) => launched.push(u));
    const item = trayMenu().find(i => i.label === 'Main');
    assert.ok(item, 'account listed once unlocked');
    item.click();
    assert.deepEqual(launched, ['alice']);
    assert.equal(state.mainWindow.counts.show, 0, 'showing is left to the launch (minimize on launch)');
});

test('the jump list names no accounts while the vault is locked', () => {
    setup({ locked: true });
    windows.updateJumpList();
    assert.deepEqual(userTasks.at(-1), []);
    fx.fakeVault.locked = false;
    windows.updateJumpList();
    assert.equal(userTasks.at(-1)[0].title, 'Launch Main');
});

test('a shortcut opens the lock screen and resumes Play after vault unlock', async () => {
    setup({ locked: true });
    const selection = '--launch-account=' + Buffer.from('alice').toString('base64url');
    await appHandlers['second-instance']({}, ['app.exe', selection]);
    assert.equal(state.mainWindow.visible, true);
    assert.equal(fx.spawned.length, 0);
    state.config.lolPath = path.join(fx.userData, 'LeagueClient.exe');
    fs.writeFileSync(state.config.lolPath, '');
    fx.fakeVault.locked = false;
    assert.equal((await launch.resumeExternalLaunch()).success, true);
    assert.equal(launch.isLaunchInProgress(), true);
    assert.equal(launch.resumeExternalLaunch(), undefined);
    launch.cancelLaunch();
});

test('the app runs in English, whatever language Windows uses', () => {
    assert.equal(require('electron').app.commandLine.switches.lang, 'en-US');
});

test('a second start without --launch just shows the window', () => {
    setup();
    appHandlers['second-instance']({}, ['app.exe']);
    assert.equal(state.mainWindow.visible, true);
});

test('--launch= keeps usernames that contain =', () => {
    assert.equal(launchArgUsername(['app.exe', '--launch=a=b']), 'a=b');
    assert.equal(launchArgUsername(['app.exe']), null);
});

test('a shortcut targets the manager and selects the saved account with one argument', async t => {
    setup();
    const username = 'Example = "account"';
    const target = path.join(fx.userData, 'LoL - Main.lnk');
    const previousProgramData = process.env.ProgramData;
    process.env.ProgramData = path.join(fx.userData, 'ProgramData');
    t.after(() => {
        if (previousProgramData === undefined) delete process.env.ProgramData;
        else process.env.ProgramData = previousProgramData;
    });
    const icon = path.join(process.env.ProgramData, 'Riot Games', 'Metadata',
        'league_of_legends.live', 'league_of_legends.live.ico');
    fs.mkdirSync(path.dirname(icon), { recursive: true });
    fs.writeFileSync(icon, '');
    t.mock.method(fakeElectron.dialog, 'showSaveDialog', async () => ({ canceled: false, filePath: target }));
    let shortcut;
    fakeElectron.shell.writeShortcutLink = (...args) => { shortcut = args; return true; };
    t.after(() => { delete fakeElectron.shell.writeShortcutLink; });

    assert.deepEqual(await createAccountShortcut(state.mainWindow, { username, label: 'Main' }), { success: true });
    assert.equal(shortcut[0], target);
    assert.equal(shortcut[2].target, process.execPath);
    assert.equal(shortcut[2].cwd, fakeElectron.app.getAppPath());
    assert.equal(shortcut[2].icon, icon);
    assert.equal(shortcut[2].iconIndex, 0);
    const selection = shortcut[2].args.match(/--launch-account=[\w-]+$/)[0];
    assert.equal(launchArgUsername([process.execPath, selection]), username);
});

test('every quit gets past the hide-to-tray close handler', () => {
    fakeElectron.app.isQuiting = false;
    appHandlers['before-quit']();
    assert.equal(fakeElectron.app.isQuiting, true);
    fakeElectron.app.isQuiting = false;
});

test('the first ready-to-show does not undo minimize on launch', async () => {
    setup({ accounts: [{ username: 'alice', password: 'x', minimizeOnLaunch: true }] });
    let kill;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) kill = child; });
    state.config.startMinimized = false;
    windows.createMainWindow();
    const win = state.mainWindow; // the fake BrowserWindow
    state.config.lolPath = path.join(fx.userData, 'LeagueClient.exe');
    fs.writeFileSync(state.config.lolPath, '');
    const pending = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => kill, 'the launch to hide the window');
    assert.equal(launch.isWindowHiddenByLaunch(), true);
    win.emit('ready-to-show');
    assert.equal(win.shown, 0);
    launch.cancelLaunch();
    kill.exit(0);
    await pending;

    windows.createMainWindow();
    state.mainWindow.emit('ready-to-show');
    assert.equal(state.mainWindow.shown, 1, 'normal start still shows the window');
});
