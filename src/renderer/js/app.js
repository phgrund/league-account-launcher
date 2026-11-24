const launcherApi = window.launcher;
const element = id => document.getElementById(id);
const list = element('account-list');
const accountDialog = element('account-dialog');
const accountForm = element('account-form');
const settingsDialog = element('settings-dialog');
const settingsForm = element('settings-form');
const vaultDialog = element('vault-dialog');
const vaultForm = element('vault-form');
const backupDialog = element('backup-dialog');
const backupForm = element('backup-form');
const confirmDialog = element('confirm-dialog');

let selectedAccount;
let selectedPath;
let backupMode;
let launchPending = false;
let launchStatus = null;
let accountsRequest = 0;

function showMessage(node, message) {
    node.textContent = message;
    node.hidden = !message;
}

function notify(message, error = true) {
    const notice = element('notice');
    notice.toggleAttribute('data-error', error);
    showMessage(notice, message);
}

function formError(form, message = '') {
    showMessage(form.querySelector('.form-error'), message);
}

async function runFormAction(form, action) {
    if (form.inert) return;
    formError(form);
    form.inert = true;
    try {
        const result = await action();
        if (result?.message && !result.success) formError(form, result.message);
    } catch (error) {
        formError(form, error.message);
    } finally {
        form.inert = false;
    }
}

function confirmAction(title, message, action) {
    element('confirm-title').textContent = title;
    element('confirm-message').textContent = message;
    element('confirm-button').textContent = action;
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
    return new Promise(resolve => {
        confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), { once: true });
    });
}

confirmDialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    confirmDialog.close(event.submitter?.value);
});

for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
}
for (const dialog of [accountDialog, settingsDialog, vaultDialog, backupDialog]) {
    dialog.addEventListener('cancel', event => {
        if (dialog.querySelector('form').inert) event.preventDefault();
    });
    dialog.addEventListener('close', () => dialog.querySelector('form').reset());
}

function updateLaunchView() {
    const active = !!launchStatus && !launchStatus.error && launchStatus.progress < 100;
    list.inert = active || launchPending;
    element('add-account').disabled = active || launchPending;
    element('open-settings').disabled = active || launchPending || !element('vault-view').hidden;
    element('launch-status').hidden = !active;
    if (active) {
        showMessage(element('launch-message'), launchStatus.message);
        element('launch-progress').value = launchStatus.progress;
    }
}

function handleLoginStatus(status) {
    launchStatus = status;
    if (status && (status.error || status.progress === 100)) notify(status.message, !!status.error);
    updateLaunchView();
}

element('cancel-launch').addEventListener('click', async () => {
    try {
        await launcherApi.cancelLaunch();
    } catch (error) {
        notify(error.message);
    }
});

async function launch(account, manual = false) {
    if (launchPending) return;
    launchPending = true;
    notify('');
    updateLaunchView();
    try {
        let result = await launcherApi.launch(account.username, { manual });
        if (result.needsConfirm) {
            const confirmed = await confirmAction('Switch accounts?', result.message, 'Switch account');
            if (!confirmed) return;
            result = await launcherApi.launch(account.username, { manual, confirmed });
        }
        if (!result.success && !result.reported && !result.cancelled) notify(result.message);
    } catch (error) {
        notify(error.message);
    } finally {
        launchPending = false;
        updateLaunchView();
    }
}

async function refreshAccounts() {
    const request = ++accountsRequest;
    try {
        const accounts = await launcherApi.getAccounts();
        if (request !== accountsRequest) return;

        const rows = accounts.map(account => {
            const row = element('account-template').content.firstElementChild.cloneNode(true);
            const name = account.label || account.riotId || account.username;
            const detail = account.riotId && account.riotId !== name ? account.riotId : account.username;
            const manual = !account.savedSignIn && !account.hasSavedPassword;
            row.querySelector('.account-label').textContent = name;
            row.querySelector('.account-detail').textContent = [
                name !== detail ? detail : '',
                account.region?.toUpperCase(),
            ].filter(Boolean).join(' · ');
            const shortcut = row.querySelector('.shortcut-account');
            shortcut.setAttribute('aria-label', `Create shortcut for ${name}`);
            shortcut.addEventListener('click', async () => {
                shortcut.disabled = true;
                try {
                    const result = await launcherApi.createShortcut(account.username);
                    if (result.success) notify('Shortcut created.', false);
                    else if (!result.cancelled) notify(result.message);
                } catch (error) {
                    notify(error.message);
                } finally {
                    shortcut.disabled = false;
                }
            });
            const edit = row.querySelector('.edit-account');
            edit.setAttribute('aria-label', `Edit ${name}`);
            edit.addEventListener('click', () => openAccount(account));
            const play = row.querySelector('.play-account');
            play.textContent = manual ? 'Sign in' : 'Play';
            play.setAttribute('aria-label', `${play.textContent} as ${name}`);
            play.addEventListener('click', () => launch(account));
            return row;
        });
        list.replaceChildren(...rows);
        element('empty').hidden = accounts.length > 0;
    } catch (error) {
        notify(error.message);
    }
}

function updateAccountMethod() {
    const adding = !selectedAccount;
    const capture = adding && element('account-method').value === 'session';
    element('account-method-field').hidden = !adding;
    element('capture-help').hidden = !capture;
    element('account-login-field').hidden = !adding || capture;
    element('account-password-field').hidden = capture;
    element('account-login').required = adding && !capture;
    element('account-password').required = adding && !capture;
    element('save-account').textContent = capture ? 'Save session' : 'Save';
    if (capture) element('account-password').value = '';
}

function openAccount(account) {
    selectedAccount = account;
    accountForm.reset();
    formError(accountForm);
    element('account-title').textContent = account ? 'Edit account' : 'Add account';
    showMessage(element('account-username'), account?.username ?? '');
    element('account-password').placeholder = account?.hasSavedPassword ? 'Leave blank to keep saved password' : '';
    element('account-label').value = account?.label ?? '';
    element('hide-on-launch').checked = !!account?.minimizeOnLaunch;
    element('delete-account').hidden = !account;
    element('manual-login').hidden = !account;
    updateAccountMethod();
    accountDialog.showModal();
}

element('add-account').addEventListener('click', () => openAccount());
element('account-method').addEventListener('change', updateAccountMethod);
accountForm.addEventListener('submit', event => {
    event.preventDefault();
    runFormAction(accountForm, async () => {
        const details = {
            label: element('account-label').value.trim(),
            minimizeOnLaunch: element('hide-on-launch').checked,
        };
        const password = element('account-password').value;
        let result;
        if (selectedAccount) {
            result = await launcherApi.updateAccount({ username: selectedAccount.username, password, ...details });
        } else if (element('account-method').value === 'session') {
            result = await launcherApi.captureAccount(details);
        } else {
            result = await launcherApi.addAccount({ username: element('account-login').value.trim(), password, ...details });
        }
        if (result.success) accountDialog.close();
        return result;
    });
});

element('manual-login').addEventListener('click', () => {
    accountDialog.close();
    launch(selectedAccount, true);
});

element('delete-account').addEventListener('click', () => {
    runFormAction(accountForm, async () => {
        const name = selectedAccount.label || selectedAccount.username;
        const ok = await confirmAction('Remove saved account?', `${name} will be removed from this launcher.`, 'Remove');
        if (!ok) return;
        const result = await launcherApi.deleteAccount(selectedAccount.username);
        if (result.success) accountDialog.close();
        return result;
    });
});

element('open-settings').addEventListener('click', async () => {
    try {
        const config = await launcherApi.getConfig();
        if (settingsDialog.open) return;
        selectedPath = undefined;
        formError(settingsForm);
        element('league-path').value = config.lolPathFound ? config.lolPath : '';
        element('theme').value = config.theme;
        element('start-minimized').checked = config.startMinimized;
        settingsDialog.showModal();
    } catch (error) {
        notify(error.message);
    }
});

element('browse-path').addEventListener('click', () => {
    runFormAction(settingsForm, async () => {
        const result = await launcherApi.chooseLeaguePath();
        if (result.success) {
            selectedPath = result.path;
            element('league-path').value = result.path;
        }
        return result;
    });
});

settingsForm.addEventListener('submit', event => {
    event.preventDefault();
    runFormAction(settingsForm, async () => {
        const settings = {
            theme: element('theme').value,
            startMinimized: element('start-minimized').checked,
        };
        if (selectedPath) settings.lolPath = selectedPath;
        const result = await launcherApi.setConfig(settings);
        if (result.success) settingsDialog.close();
        return result;
    });
});

element('vault-settings').addEventListener('click', () => {
    runFormAction(settingsForm, async () => {
        const { enabled } = await launcherApi.getVaultState();
        formError(vaultForm);
        element('vault-current-field').hidden = !enabled;
        element('vault-current').required = enabled;
        element('disable-vault').hidden = !enabled;
        vaultDialog.showModal();
    });
});

vaultForm.addEventListener('submit', event => {
    event.preventDefault();
    runFormAction(vaultForm, async () => {
        const result = await launcherApi.setVaultPassword({
            current: element('vault-current').value,
            next: element('vault-next').value,
        });
        if (result.success) vaultDialog.close();
        return result;
    });
});

element('disable-vault').addEventListener('click', () => {
    runFormAction(vaultForm, async () => {
        const current = element('vault-current').value;
        if (!current) return { success: false, message: 'Enter your current vault password.' };
        const result = await launcherApi.disableVault(current);
        if (result.success) vaultDialog.close();
        return result;
    });
});

function showBackupDialog(mode) {
    backupMode = mode;
    const exporting = mode === 'export';
    const action = exporting ? 'Export' : 'Import';
    element('backup-title').textContent = `${action} accounts`;
    element('backup-submit').textContent = action;
    if (exporting) element('backup-password').minLength = 8;
    else element('backup-password').removeAttribute('minlength');
    formError(backupForm);
    backupDialog.showModal();
}

function reportImport(result) {
    notify(`Imported ${result.added} account(s). Skipped ${result.skipped}. Sign in through Riot to save their sessions.`, false);
}

element('import-accounts').addEventListener('click', () => {
    runFormAction(settingsForm, async () => {
        const result = await launcherApi.importAccounts();
        if (result.success) {
            settingsDialog.close();
            reportImport(result);
        } else if (result.needsPassphrase) {
            showBackupDialog('import');
        }
        return result;
    });
});
element('export-accounts').addEventListener('click', () => showBackupDialog('export'));

backupForm.addEventListener('submit', event => {
    event.preventDefault();
    runFormAction(backupForm, async () => {
        const passphrase = element('backup-password').value;
        const exporting = backupMode === 'export';
        const result = exporting ? await launcherApi.exportAccounts(passphrase) : await launcherApi.importAccounts(passphrase);
        if (result.success) {
            backupDialog.close();
            settingsDialog.close();
            if (exporting) {
                notify(`Exported ${result.count} account(s).`, false);
            } else {
                reportImport(result);
            }
        } else if (result.wrongPassphrase) {
            return { success: false, message: 'Incorrect backup passphrase.' };
        }
        return result;
    });
});

const unlockForm = element('unlock-form');
unlockForm.addEventListener('submit', event => {
    event.preventDefault();
    runFormAction(unlockForm, async () => {
        const result = await launcherApi.unlockVault(element('unlock-password').value);
        if (result.success) {
            unlockForm.reset();
            await initializeAccounts();
        }
        return result;
    });
});

async function initializeAccounts() {
    try {
        const { unlocked } = await launcherApi.getVaultState();
        element('vault-view').hidden = unlocked;
        element('accounts-view').hidden = !unlocked;
        updateLaunchView();
        if (!unlocked) element('unlock-password').focus();
        else await refreshAccounts();
    } catch (error) {
        notify(error.message);
    }
}

async function startLauncher() {
    try {
        if (!launcherApi) throw new Error('The connection to the launcher process is unavailable.');
        launcherApi.onLoginStatus(handleLoginStatus);
        launcherApi.onDataFileProblem(message => notify(message));
        launcherApi.onAccountsUpdated(refreshAccounts);
        await initializeAccounts();
    } catch (error) {
        notify(error.message);
    }
}

startLauncher();
