const { app } = require('electron');
const childProcess = require('node:child_process');
const path = require('node:path');

const loginResults = new Map([
    [0, 'submitted'],
    [1, 'form-missing'],
    [2, 'focus-lost'],
    [3, 'input-failed'],
]);

function riotWindowArguments(clientPath) {
    const script = app.isPackaged
        ? path.join(process.resourcesPath, 'resources', 'scripts', 'login.ps1')
        : path.join(__dirname, '../../../resources/scripts/login.ps1');
    return [
        '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-InstallDir', path.dirname(clientPath),
    ];
}

function minimizeRiotWindow(clientPath) {
    if (!clientPath) return;
    try {
        const args = [...riotWindowArguments(clientPath), '-Minimize', '-StartedBefore', String(Date.now())];
        const child = childProcess.spawn('powershell.exe', args,
            { windowsHide: true, stdio: 'ignore' });
        child.once('error', () => {});
        child.unref();
    } catch {
        // League has already opened. Window minimization is best effort.
    }
}

function pressLeaguePlay(clientPath, signal) {
    if (!clientPath || signal.aborted) return Promise.resolve(false);

    return new Promise(resolve => {
        const child = childProcess.spawn('powershell.exe', [...riotWindowArguments(clientPath), '-PlayLeague'], {
            windowsHide: true,
            stdio: 'ignore',
            signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        });
        child.once('error', () => resolve(false));
        child.once('close', code => resolve(code === 0));
    });
}

function submitRiotCredentials({ username, password, clientPath, startedAt, signal }) {
    if (signal.aborted) return Promise.resolve('helper-failed');

    return new Promise(resolve => {
        const child = childProcess.spawn('powershell.exe', [
            ...riotWindowArguments(clientPath), '-NotBefore', String(startedAt),
        ], {
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'ignore'],
            signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
        });

        child.once('error', () => resolve('helper-failed'));
        child.once('close', code => resolve(loginResults.get(code) ?? 'helper-failed'));
        child.stdin.on('error', () => resolve('helper-failed'));
        // ASCII transport preserves UTF-8 under Windows PowerShell's console code page.
        const payload = Buffer.from(JSON.stringify({ username, password }), 'utf8');
        child.stdin.write(payload.toString('base64') + '\n');
        payload.fill(0);
        child.stdin.end();
    });
}

module.exports = { minimizeRiotWindow, pressLeaguePlay, submitRiotCredentials };
