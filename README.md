# XAU Companion

A companion for [Xbox Achievement Unlocker](https://github.com/Fumo-Unlockers/Xbox-Achievement-Unlocker). Requires Node.js 18+ and a running XAU API.

Run `Start XAU Companion.bat` (Windows) or `Start XAU Companion.command` (macOS), or start manually:

```sh
npm start
```

Open http://127.0.0.1:3000. Set `XAU_URL` to change the default XAU address (`http://192.168.1.119:1337`).

Choose a game, load an Xbox timeline by gamertag or import it manually, select achievements, and start copying. Copying requires a confirmed Title Based game from the online Fumo Unlockers catalog. Pausing preserves the remaining delay; progress and the XAU account are stored in `state.json`. The queue pauses if the account changes. The server stops shortly after the last page closes; reopen the app to resume the queue. Only individual unlock requests are used, at least 60 seconds apart.

History uses the XAU account’s Xbox authorization and depends on the reference player’s privacy settings. Manual import accepts one `achievement name<TAB>ISO 8601 timestamp with timezone` per line. Review the queue before starting.
