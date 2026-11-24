const { dialog, ipcMain, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { readLockfile, requestLocalClient } = require('../services/local-client');
// Called as childProcess.spawn (not destructured) so tests can stand in a fake.
const childProcess = require('child_process');
const state = require('../state');
const { loadAccounts, updateAccounts, sameUser } = require('../services/storage');
const { broadcastAccountsUpdate, showMainWindow } = require('../windows');
const lcu = require('../lcu');
const riotSessions = require('../services/riot-sessions');
const { decodeUserInfo, parseBan } = require('../services/account-status');
const { decryptPassword } = require('../services/account-password');
const { minimizeRiotWindow, pressLeaguePlay, submitRiotCredentials } = require('../services/credential-login');

// Everything that has to be gone before another account can sign in. Current
// Riot Client builds run their UI as "Riot Client.exe", older ones as
// RiotClientUx; LeagueClientUxRender is League's renderer process.
const CLIENT_PROCESS_NAMES = [
    'LeagueClient', 'LeagueClientUx', 'LeagueClientUxRender',
    'RiotClientServices', 'RiotClientUx', 'Riot Client',
];
const LEAGUE_PRODUCT = 'league_of_legends';

// Phases in which restarting the clients would throw the player out of a game.
const IN_GAME_PHASES = new Set(['ChampSelect', 'GameStart', 'InProgress', 'Reconnect']);

// The kill command waits up to 10 s for the processes to exit; this is the
// outer bound for powershell.exe itself (start-up included).
const POWERSHELL_TIMEOUT_MS = 20000;
// The League client can take a while to answer after sign-in.
const SESSION_CHECK_TIMEOUT_MS = 25000;
const SESSION_CHECK_INTERVAL_MS = 1000;

const AUTH_POLL_MS = 1000;
// How long a restored sign-in may take before the password is typed instead,
// and how long the user has to sign in by hand (Sign in in the account panel).
const SIGNIN_TIMEOUTS = { saved: 25000, manual: 180000 };
const AUTO_SIGN_IN_MESSAGES = {
    submitted: 'Waiting for Riot sign-in. Complete any verification in the Riot Client.',
    'form-missing': 'The Riot sign-in fields were not found. Open the username and password tab and sign in.',
    'focus-lost': 'The Riot sign-in fields did not get focus. Sign in through the Riot Client.',
    'input-failed': 'Windows could not send text to the Riot sign-in fields. Sign in through the Riot Client.',
    'helper-failed': 'The automatic sign-in helper stopped. Sign in through the Riot Client.',
};

function send(channel, ...args) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send(channel, ...args);
    }
}

// The vault gate lives in services/vault.js (required lazily: it requires
// storage, which requires this module's dependencies).
function isVaultLocked() {
    return require('../services/vault').isVaultLocked();
}

function later(ms, fn) {
    const t = setTimeout(fn, ms);
    if (typeof t?.unref === 'function') t.unref();
    return t;
}

const sleep = (ms) => new Promise(r => later(ms, r));

// Riot's own record of where the Riot Client lives (written by its installer),
// so non-standard installs (Steam library, custom drives) are found reliably.
function riotClientFromInstallsJson() {
    try {
        const file = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Riot Games', 'RiotClientInstalls.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const leagueDir = path.dirname(state.config.lolPath || '').replace(/\\/g, '/').toLowerCase();
        const associated = Object.entries(data.associated_client || {})
            .find(([dir]) => dir.replace(/\/$/, '').toLowerCase() === leagueDir)?.[1];
        return [associated, data.rc_live, data.rc_default].filter(Boolean).map(p => path.normalize(p));
    } catch {
        return [];
    }
}

function discoverRiotClientPath() {
    const base = path.dirname(path.dirname(state.config.lolPath));
    const candidates = [
        ...riotClientFromInstallsJson(),
        path.join(base, 'Riot Client', 'RiotClientServices.exe'),
        'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
        'D:\\Riot Games\\Riot Client\\RiotClientServices.exe',
        ...['E', 'F', 'G'].map(d => `${d}:\\Riot Games\\Riot Client\\RiotClientServices.exe`),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

// Stops the processes, then waits (up to 10 s) until they are really gone, so
// the new Riot Client never starts next to a dying one whose window the login
// script could pick.
function killProcessesCommand(names) {
    const list = names.map(n => `'${n}'`).join(',');
    return `$n = @(${list}); `
        + 'Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; '
        + 'for ($i = 0; $i -lt 40 -and (Get-Process -Name $n -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }; '
        + 'if (Get-Process -Name $n -ErrorAction SilentlyContinue) { exit 1 }';
}

// Runs a PowerShell command without a console window and resolves with its
// exit code (null if it could not start or hung). Never rejects: a failed
// spawn used to be an unhandled 'error' event that crashed the main process.
function runPowerShell(command) {
    return new Promise((resolve) => {
        let child;
        try {
            child = childProcess.spawn('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', command],
                { windowsHide: true, stdio: 'ignore' });
        } catch (e) {
            console.error('[Launch] powershell.exe could not start:', e.message);
            resolve(null);
            return;
        }
        const timer = later(POWERSHELL_TIMEOUT_MS, () => {
            child.kill();
            resolve(null);
        });
        child.once('error', (e) => {
            clearTimeout(timer);
            console.error('[Launch] powershell.exe failed:', e.message);
            resolve(null);
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

// Launches the exe directly (no shell) instead of building a `powershell -Command`
// string: riotClientPath/lolPath are derived from user/config-supplied paths,
// and interpolating them into a shell command string is a command-injection
// vector (a path containing `"; ...` would execute arbitrary commands).
// Returns false when there is nothing to start; onError gets async spawn failures.
function launchClient(riotClientPath, onError) {
    let target = null;
    let args = [];
    if (riotClientPath) {
        target = riotClientPath;
        args = [`--launch-product=${LEAGUE_PRODUCT}`, '--launch-patchline=live', '--allow-direct-launch'];
    } else if (state.config.lolPath && fs.existsSync(state.config.lolPath)) {
        target = state.config.lolPath;
    }
    if (!target) return false;
    try {
        const child = childProcess.spawn(target, args, { detached: true, stdio: 'ignore' });
        child.on('error', (e) => {
            console.error('[Launch] Could not start', target, e.message);
            onError(e);
        });
        child.unref();
    } catch (e) {
        console.error('[Launch] Could not start', target, e.message);
        onError(e);
    }
    return true;
}

// Compares the account the League client is signed in with against the one
// that was launched. ok: null means the session could not be read.
function verifyLoggedInAccount(expectedUsername, session) {
    const actual = session?.username;
    if (!actual) return { ok: null };
    if (sameUser(actual, expectedUsername)) return { ok: true };
    return { ok: false, actual };
}

function riotClientLockfilePath() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
}

async function riotClientRequest(method, endpoint, timeout) {
    const credentials = readLockfile(riotClientLockfilePath());
    return credentials ? requestLocalClient(credentials, method, endpoint, timeout) : null;
}

async function riotClientAuthState() {
    try {
        const response = await riotClientRequest('GET', '/rso-auth/v1/authorization');
        if (response?.status === 404) return 'signed-out';
        return response?.status >= 200 && response.status < 300 ? 'signed-in' : 'unknown';
    } catch {
        return 'unknown';
    }
}

async function riotClientStartLeague() {
    try {
        // The installed Riot Client uses clickWallMs when the user presses Play.
        const endpoint = `/product-launcher/v1/products/${LEAGUE_PRODUCT}/patchlines/live?clickWallMs=${Date.now()}`;
        return await riotClientRequest('POST', endpoint, 6000);
    } catch (error) {
        console.log('[Launch] Riot Client could not start League:', error.message);
        return null;
    }
}

async function riotClientUserInfo() {
    try {
        const response = await riotClientRequest('GET', '/riot-client-auth/v1/userinfo', 1800);
        return response?.status === 200 ? decodeUserInfo(response.data) : null;
    } catch {
        return null;
    }
}

// Serialize switches so only one launch can change the Riot Client's session.
let launchSeq = 0;
let activeLaunch = null;
let closingClients = false;
let launchAfterUnlock = null;

function isCurrent(launch) {
    return activeLaunch === launch;
}

function isLaunchInProgress() {
    return activeLaunch !== null || closingClients;
}

// True while a launch has hidden the main window (minimize on launch), so the
// window's first ready-to-show does not bring it back.
function isWindowHiddenByLaunch() {
    return !!activeLaunch?.hidWindow;
}

function status(launch, message, progress, extra = {}) {
    if (!isCurrent(launch)) return;
    // Progress never goes backwards within one launch.
    launch.progress = Math.max(launch.progress, progress);
    send('login-status', { message, progress: launch.progress, ...extra });
}

// Clears the progress status after a finished launch unless a newer one started.
function clearStatusLater(ms) {
    const seq = launchSeq;
    later(ms, () => {
        if (launchSeq === seq && !activeLaunch) send('login-status', null);
    });
}

function notify(title, body) {
    try {
        const n = new Notification({
            title,
            body,
            icon: path.join(__dirname, '../../renderer/assets/logo.png'),
        });
        n.on('click', showMainWindow);
        n.show();
    } catch { /* notifications may not be supported in this environment */ }
}

// Brings the window back for a message the user has to see (minimize on
// launch would otherwise leave it hidden), with a notification if it was hidden.
function revealWindow(title, message) {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    const wasHidden = !win.isVisible();
    showMainWindow();
    if (wasHidden) notify(title, message);
}

function fail(launch, message, kind) {
    if (!isCurrent(launch)) return;
    activeLaunch = null;
    launch.controller.abort();
    send('login-status', { message, progress: 0, error: true, kind });
    revealWindow('Login did not complete', message);
    clearStatusLater(5000);
}

function succeed(launch, message) {
    if (!isCurrent(launch)) return;
    broadcastAccountsUpdate();
    send('login-status', { message, progress: 100, kind: 'done' });
    activeLaunch = null;
    clearStatusLater(3000);
}

// Polls the League client for the signed-in account until it answers, the
// launch is cancelled, or the timeout passes (then null).
async function waitForSession(launch) {
    const deadline = Date.now() + SESSION_CHECK_TIMEOUT_MS;
    while (isCurrent(launch) && Date.now() < deadline) {
        const session = await lcu.request('GET', '/lol-login/v1/session');
        if (session?.username) return session;
        await sleep(SESSION_CHECK_INTERVAL_MS);
    }
    return null;
}

// Once the Riot Client is signed in: reads whether the account is banned,
// and stops the launch while a ban runs.
function checkBan(launch, info) {
    const ban = parseBan(info);
    if (!isCurrent(launch)) return false;
    if (!ban || (!ban.permanent && ban.until <= Date.now())) return false;
    fail(launch, ban.permanent
        ? `${launch.label} is permanently banned.`
        : `${launch.label} is suspended until ${new Date(ban.until).toLocaleString()}.`, 'banned');
    return true;
}

// Waits until the Riot Client reports a signed-in player, the launch is
// cancelled or the time is up. Returns true when signed in.
async function waitForSignIn(launch, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (isCurrent(launch) && Date.now() < deadline) {
        if (await riotClientAuthState() === 'signed-in') return true;
        await sleep(AUTH_POLL_MS);
    }
    return false;
}

// After a sign-in without typing: start League, check the account in the
// League client and keep the (refreshed) sign-in for next time.
async function finishSignedIn(launch, restored = false, knownUserInfo = null) {
    const info = knownUserInfo ?? await riotClientUserInfo();
    if (!isCurrent(launch) || checkBan(launch, info)) return;
    const signedInUser = info?.preferred_username ?? info?.username;
    if (typeof signedInUser === 'string' && signedInUser && !sameUser(signedInUser, launch.username)) {
        if (restored) riotSessions.forgetSignIn(launch.username);
        broadcastAccountsUpdate();
        fail(launch, `Riot is signed in as ${signedInUser}, not ${launch.label}. Choose the correct account in the Riot Client.`, 'wrong-account');
        return;
    }
    let session = await lcu.request('GET', '/lol-login/v1/session');
    if (!isCurrent(launch)) return;
    if (!session?.username) {
        status(launch, 'Launching League...', 88);
        const play = await riotClientStartLeague();
        if (!isCurrent(launch)) return;
        let accepted = play && ((play.status >= 200 && play.status < 300) || play.status === 409);
        // A cold launch can already hold the product launch lock while League starts.
        if (launch.requestedDirectLaunch && play?.status === 423) accepted = true;
        if (!accepted) {
            session = await lcu.request('GET', '/lol-login/v1/session');
            if (!isCurrent(launch)) return;
        }
        if (!session?.username && play?.status === 464) {
            status(launch, 'Pressing League Play in the Riot Client...', 90);
            accepted = await pressLeaguePlay(launch.riotClientPath, launch.controller.signal);
            if (!isCurrent(launch)) return;
        }
        // Play can disappear as soon as League starts, before its session is readable.
        if (!session?.username && (accepted || play?.status === 464)) {
            status(launch, 'Waiting for League to open...', 92);
            session = await waitForSession(launch);
            if (!isCurrent(launch)) return;
        }
        if (!accepted && !session?.username) {
            const detail = play?.status ? ` (HTTP ${play.status})` : '';
            const reason = play?.status === 464
                ? 'The manager could not find an enabled League Play button in the Riot Client.'
                : `Riot could not start League${detail}.`;
            fail(launch, `${reason} Open the League page in the Riot Client to check Play or any pending update.`, 'needs-action');
            return;
        }
    }
    if (!isCurrent(launch)) return;
    const check = verifyLoggedInAccount(launch.username, session);
    if (check.ok === false) {
        if (restored) {
            riotSessions.forgetSignIn(launch.username);
            broadcastAccountsUpdate();
        }
        fail(launch, `Signed in as ${check.actual}, not ${launch.label}. Sign out in the Riot Client and try again.`, 'wrong-account');
        return;
    }
    if (check.ok === null) {
        fail(launch, 'League did not report a session after Play. Check the Riot Client for an update or error.', 'needs-action');
        return;
    }
    const kept = await riotSessions.captureSignIn(launch.username, () => isCurrent(launch));
    if (!isCurrent(launch)) return;
    succeed(launch, kept ? 'Session saved.' : 'Signed in. Tick "Stay signed in" to save the session next time.');
    minimizeRiotWindow(launch.riotClientPath);
    notify('League Launched!', `${launch.label} is ready to play.`);
}

async function signIn(launch, { restored, manual, clientPath, startedAt }) {
    let message = 'Sign in in the Riot Client and tick "Stay signed in".';
    if (restored) {
        status(launch, 'Opening the saved session...', 55);
        if (await waitForSignIn(launch, SIGNIN_TIMEOUTS.saved)) {
            await finishSignedIn(launch, true);
            return;
        }
        if (!isCurrent(launch)) return;
        riotSessions.forgetSignIn(launch.username);
        broadcastAccountsUpdate();
        message = 'Session expired. Sign in again in the Riot Client and tick "Stay signed in".';
    }

    if (!manual && clientPath) {
        const account = loadAccounts().find(candidate => sameUser(candidate.username, launch.username));
        if (account?.encryptedPassword) {
            const password = await decryptPassword(account.encryptedPassword);
            if (!isCurrent(launch)) return;
            if (password) {
                status(launch, 'Signing in through the Riot Client...', 60);
                const result = await submitRiotCredentials({
                    username: launch.username, password, clientPath, startedAt, signal: launch.controller.signal,
                });
                message = AUTO_SIGN_IN_MESSAGES[result];
            } else {
                message = 'Windows could not unlock the saved password. Sign in through Riot or update it under Edit.';
            }
        }
    }

    if (!isCurrent(launch)) return;
    status(launch, message, 60);
    if (await waitForSignIn(launch, SIGNIN_TIMEOUTS.manual)) {
        await finishSignedIn(launch);
        return;
    }
    if (isCurrent(launch)) fail(launch, 'No sign-in in the Riot Client. Try again when you are ready.', 'needs-action');
}

const CANCELLED = Object.freeze({ success: false, cancelled: true });

async function executeAccountLaunch(username, opts = {}) {
    if (isVaultLocked()) return { success: false, locked: true, message: 'Vault is locked' };
    if (isLaunchInProgress()) return { success: false, busy: true, message: 'A launch is already in progress' };

    const accounts = loadAccounts();
    const account = accounts.find(a => sameUser(a.username, username));
    if (!account) return { success: false, message: 'Account not found' };

    const launch = {
        username: account.username,
        label: account.label || account.username,
        hidWindow: false,
        progress: 0,
        controller: new AbortController(),
    };
    // Claim before waiting for the running client to respond.
    launchSeq++;
    activeLaunch = launch;

    try {
        const [session, phase] = await Promise.all([
            lcu.request('GET', '/lol-login/v1/session'),
            lcu.request('GET', '/lol-gameflow/v1/gameflow-phase'),
        ]);
        if (!isCurrent(launch)) return CANCELLED;
        if (sameUser(session?.username, account.username)) {
            updateAccounts((fresh) => {
                const current = fresh.find(a => sameUser(a.username, account.username));
                if (!current) return false;
                current.lastUsed = Date.now();
            });
            const kept = await riotSessions.captureSignIn(account.username, () => isCurrent(launch));
            if (!isCurrent(launch)) return CANCELLED;
            succeed(launch, kept ? 'Session saved.' : 'Already signed in. Tick "Stay signed in" to save the session next time.');
            return { success: true };
        }
        if (IN_GAME_PHASES.has(phase) && !opts.confirmed) {
            activeLaunch = null;
            return { success: false, needsConfirm: true, message: 'You are in a game. Launching another account closes League.' };
        }
        const riotClientPath = discoverRiotClientPath();
        launch.riotClientPath = riotClientPath;
        if (!opts.manual && !session?.username && !IN_GAME_PHASES.has(phase)) {
            const info = await riotClientUserInfo();
            if (!isCurrent(launch)) return CANCELLED;
            const username = info?.preferred_username ?? info?.username;
            if (sameUser(username, account.username)) {
                updateAccounts((fresh) => {
                    const current = fresh.find(a => sameUser(a.username, account.username));
                    if (!current) return false;
                    current.lastUsed = Date.now();
                });
                if (account.minimizeOnLaunch && state.mainWindow && !state.mainWindow.isDestroyed()) {
                    state.mainWindow.hide();
                    launch.hidWindow = true;
                }
                finishSignedIn(launch, false, info).catch(error => fail(launch, `Login failed: ${error.message}`, 'failed'));
                return { success: true };
            }
        }
        if (!riotClientPath && !fs.existsSync(state.config.lolPath)) {
            const message = 'Could not find the Riot Client or League of Legends. Set the path in Settings.';
            fail(launch, message, 'failed');
            return { success: false, message, reported: true };
        }
        if (session?.username && accounts.some(a => sameUser(a.username, session.username))) {
            await riotSessions.captureSignIn(session.username, () => isCurrent(launch));
            if (!isCurrent(launch)) return CANCELLED;
        }

        updateAccounts((fresh) => {
            const current = fresh.find(a => sameUser(a.username, account.username));
            if (!current) return false; // deleted meanwhile: don't bring it back
            current.lastUsed = Date.now();
        });
        broadcastAccountsUpdate();

        if (account.minimizeOnLaunch && state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.hide();
            launch.hidWindow = true;
        }
        status(launch, 'Closing League and the Riot Client...', 10);
        closingClients = true;
        const closeResult = await runPowerShell(killProcessesCommand(CLIENT_PROCESS_NAMES));
        closingClients = false;
        if (!isCurrent(launch)) return CANCELLED;
        if (closeResult !== 0) {
            const message = 'Could not close League or the Riot Client. Close them and try again.';
            fail(launch, message, 'failed');
            return { success: false, message, reported: true };
        }

        // The Riot Client reads its kept sign-in at start: put this account's
        // in place (or clear another account's) while it is closed.
        const restored = await riotSessions.restoreSignIn(opts.manual ? null : account.username, launch.controller.signal);
        if (!isCurrent(launch)) return CANCELLED;

        status(launch, 'Launching Riot Client...', 30);
        const startedAt = Date.now();
        launch.requestedDirectLaunch = Boolean(riotClientPath);
        const started = launchClient(riotClientPath, (e) =>
            fail(launch, `Could not start the Riot Client (${e.code || e.message}).`, 'failed'));
        if (!started || !isCurrent(launch)) {
            return { success: false, reported: true };
        }

        signIn(launch, { restored, manual: opts.manual, clientPath: riotClientPath, startedAt })
            .catch(error => fail(launch, `Login failed: ${error.message}`, 'failed'));
        return { success: true };
    } catch (e) {
        console.error('[Launch] Unexpected error:', e);
        const message = `Launch failed: ${e.message}`;
        const wasCurrent = isCurrent(launch);
        fail(launch, message, 'failed');
        return { success: false, message, reported: wasCurrent };
    }
}

function cancelLaunch() {
    if (!activeLaunch) return { success: false, message: 'No launch in progress' };
    activeLaunch.controller.abort();
    activeLaunch = null;
    send('login-status', null);
    return { success: true };
}

// Tray, jump list and `--launch=`: no renderer is waiting on the result, so
// the window (lock screen, error) is shown here instead.
async function launchFromOutside(username) {
    if (isVaultLocked()) {
        launchAfterUnlock = username;
        showMainWindow();
        return { success: false, locked: true, message: 'Vault is locked' };
    }
    const win = state.mainWindow;
    const wasHidden = !!win && !win.isDestroyed() && !win.isVisible();
    const account = loadAccounts().find(a => sameUser(a.username, username));
    if (!account?.minimizeOnLaunch) showMainWindow();

    let res = await executeAccountLaunch(username);
    if (res.needsConfirm) {
        showMainWindow();
        const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            message: res.message,
            buttons: ['Cancel', 'Switch account'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
        });
        if (response !== 1) return { success: false, cancelled: true };
        res = await executeAccountLaunch(username, { confirmed: true });
    }
    if (res.busy) {
        showMainWindow(); // the running launch's progress is on screen
    } else if (!res.success && !res.cancelled && !res.reported) {
        send('login-status', { message: res.message, progress: 0, error: true, kind: 'failed' });
        clearStatusLater(5000);
        showMainWindow();
        if (wasHidden) notify('Could not launch', res.message);
    }
    return res;
}

function resumeExternalLaunch() {
    if (!launchAfterUnlock || isVaultLocked()) return;
    const username = launchAfterUnlock;
    launchAfterUnlock = null;
    return launchFromOutside(username);
}

function register() {
    ipcMain.handle('launch-account', (event, username, opts) =>
        executeAccountLaunch(username, {
            confirmed: !!opts?.confirmed,
            manual: !!opts?.manual,
        }));

    ipcMain.handle('cancel-launch', () => cancelLaunch());
}

module.exports = {
    register,
    executeAccountLaunch,
    launchFromOutside,
    resumeExternalLaunch,
    cancelLaunch,
    isLaunchInProgress,
    isWindowHiddenByLaunch,
    isVaultLocked,
    riotClientFromInstallsJson,
    verifyLoggedInAccount,
    SIGNIN_TIMEOUTS,
};
