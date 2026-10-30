# Xbox Achievment Hunter

Windows companion app for Xbox profiles, games, achievements, presence and statistics.

## Features

- Automatically opens the Xbox PC app when needed and tries to connect to the signed-in account. Authorization stays in memory; keep Xbox PC open and signed in. Signing out of the companion disables automatic reconnection until you connect again.
- Browse your profile and game library, search by name or Title ID, and filter games by title-based support, completion and available achievements.
- View achievements and copy a reference player's unlock history using an automatically scheduled queue. Choose the achievements, adjust estimated play time, pause or resume the queue, inspect its log and handle uncertain results.
- Start or stop game presence spoofing in the game page. See the current session time and request the latest play time available from Xbox. Presence and play time may take time to update.
- Open the Stats tab on a game, load available Xbox statistics, edit values and save individual stats. The app checks whether Xbox reports the new value; an unconfirmed write is shown as pending, not as confirmed. Support depends on the game, Xbox permissions and stat type; event-based stats may not be writable.
- Keep the queue, filters, achievement selections, profile snapshots and last spoof session in the application data directory. A spoof does not restart after the app closes.

## Windows build

Install Node.js 22.12 or later, then run `npm ci` and `npm run build:win`. The portable build is `dist/Xbox-Achievment-Hunter-1.0.0-Windows.exe`. The built application does not require Node.js. Sign in to the Xbox PC app when prompted.

The app retains data from earlier versions in the existing `XAU Companion` application-data directory. Xbox PC authorization is not saved to disk. Changes made in Xbox may be delayed or rejected by Xbox services.

## Credits

- [Xbox Achievement Unlocker — caiobrasuca fork](https://github.com/caiobrasuca/Xbox-Achievement-Unlocker): reference for the stats editor request formats and Xbox PC app launch.
- [Xbox Achievement Unlocker — Fumo-Unlockers](https://github.com/Fumo-Unlockers/Xbox-Achievement-Unlocker): original project behind the fork.
- [Xbox](https://www.xbox.com/): Xbox PC application and Xbox services used for account, game, achievement, presence and statistics data.
- [XAU](https://xau.lol/): game search and optional external backend.
- [TrueAchievements](https://www.trueachievements.com/): optional reference-player search.
- [Electron](https://www.electronjs.org/) and [electron-builder](https://www.electron.build/): desktop application runtime and Windows packaging.

The Xbox Achievement Unlocker application code is GPL-licensed; see its repository for license information. Xbox and other product names belong to their respective owners.
