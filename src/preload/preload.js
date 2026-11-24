const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
    getAccounts: () => ipcRenderer.invoke('get-accounts'),
    captureAccount: details => ipcRenderer.invoke('capture-account', details),
    addAccount: details => ipcRenderer.invoke('add-account', details),
    updateAccount: account => ipcRenderer.invoke('update-account', account),
    deleteAccount: username => ipcRenderer.invoke('delete-account', username),
    createShortcut: username => ipcRenderer.invoke('create-account-shortcut', username),
    exportAccounts: password => ipcRenderer.invoke('export-accounts', password),
    importAccounts: password => ipcRenderer.invoke('import-accounts', password === undefined ? undefined : { passphrase: password }),
    launch: (username, options) => ipcRenderer.invoke('launch-account', username, options),
    cancelLaunch: () => ipcRenderer.invoke('cancel-launch'),
    getConfig: () => ipcRenderer.invoke('get-config'),
    chooseLeaguePath: () => ipcRenderer.invoke('choose-league-path'),
    setConfig: settings => ipcRenderer.invoke('set-config', settings),
    getVaultState: () => ipcRenderer.invoke('get-vault-state'),
    unlockVault: password => ipcRenderer.invoke('unlock-vault', password),
    setVaultPassword: passwords => ipcRenderer.invoke('set-vault-password', passwords),
    disableVault: password => ipcRenderer.invoke('disable-vault', password),
    onAccountsUpdated(callback) {
        ipcRenderer.on('accounts-updated', () => callback());
    },
    onLoginStatus(callback) {
        ipcRenderer.on('login-status', (event, status) => callback(status));
    },
    onDataFileProblem(callback) {
        ipcRenderer.on('data-file-problem', (event, message) => callback(message));
    },
});
