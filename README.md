# League Account Launcher

Windows launcher for switching League of Legends accounts.

1. Choose **Add account** and enter your Riot login details. For an active session, choose **Active Riot session** while League is open with **Stay signed in** enabled.
2. Use **Play** beside a saved account. The launcher tries the saved session first and can fill in the Riot login form using a saved password when needed.
3. Choose **Create shortcut** beside an account to save a Windows shortcut that starts its Play flow after any required vault unlock.

- Detects League automatically. If the installation moved, choose `LeagueClient.exe` in **Settings**.
- Stores passwords and sessions locally with Windows encryption. An optional vault passphrase locks the launcher.
- Complete verification in the Riot Client. Choose **Edit → Sign in manually** to enter your login there yourself.
- Imports and exports account labels and preferences through encrypted `.lalbackup` backups. Passwords and sessions stay on the PC.

## Run on Windows

```powershell
npm ci
npm start
npm test
npm run build
```

Use Node.js 22.12 or later. The installer is built into `dist`.

League Account Launcher is an independent project and is unaffiliated with Riot Games.
