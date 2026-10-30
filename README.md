# XAU Companion

Requires Node.js 18+.

```sh
npm install
npm start
```

For development, run `npm run dev`. Changes reload the page after five seconds; backend changes also restart the server.

Open http://127.0.0.1:3000 and sign in with an XAuth token. Use `Start on Windows.bat` (Windows) or `Start on Mac.command` (macOS) to install missing dependencies and open the app automatically. The XAuth token is saved locally in `.auth/xauth.json` and removed when you sign out.

Choose a title-based game, load a player's history, confirm total play time, select achievements, and start the queue. Intervals are estimates based on the full history; excluded achievements and their allocated time are removed. The queue and journal are saved in `state.json`; unlock requests are at least 2 seconds apart. The server stops after the last page closes. For an existing XAU server, set `XAU_URL` to its address before starting.

In a game, use Start spoof to send its presence independently of the achievement queue. The heartbeat is refreshed every 4 minutes 50 seconds while the server is running. Stop spoof ends the direct Xbox presence session; with an external XAU server, presence expires after heartbeats stop. Spoof sessions do not resume after the server stops.
