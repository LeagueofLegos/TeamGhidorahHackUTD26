# Run Ghidorah in PyCharm

## Already using Bryan's project

1. Open `C:\Users\BF041\OneDrive\Documents\TeamGhidorahHackUTD26` in PyCharm.
2. Open **Terminal** at the bottom, or press **Alt + F12**.
3. Stop old backend/watch commands with **Ctrl + C**. If Windows asks `Terminate batch job (Y/N)?`, enter `Y`.
4. In the terminal, run:

```powershell
cd C:\Users\BF041\OneDrive\Documents\TeamGhidorahHackUTD26
npm.cmd start
```

Keep this terminal open. Wait for **Backend ready**, then open **http://127.0.0.1:5173** in your browser. The normal first screen loads the October 8 noon snapshot. S2's modeled response cost should be about **$3,120.94**.

Dependencies have already been installed in Bryan's synced project. After a future dependency update, run `npm.cmd run setup` once before starting again. `npm.cmd run dev` remains an alias for the same entry point.

## First setup for a teammate

Install Node.js/npm, Git, and the SpacetimeDB CLI. This project was verified with **Node.js 26.13.0**, **npm 11.20.0**, and **SpacetimeDB 2.14.1**. Restart PyCharm after installing tools so its terminal receives the updated PATH.

Check them:

```powershell
node --version
npm.cmd --version
git --version
spacetime --version
```

Clone the integrated branch, open that folder in PyCharm, and run:

```powershell
git clone --branch backend/data-loader https://github.com/bgf2004/TeamGhidorahHackUTD26.git
cd TeamGhidorahHackUTD26
npm.cmd run setup
npm.cmd run data:fetch
npm.cmd start
```

`setup` installs the backend and frontend from their lockfiles. `data:fetch` downloads the three pinned practice input files into the ignored backend data directory. It does not download answer keys. These installation/download commands are needed once on a fresh checkout; normal launches use only `npm.cmd start`.

The integration is on **`backend/data-loader`**. The frontend source was imported from the team's `frontend` branch into the `frontend/` folder; that original branch is preserved. `main.mjs` is the application's entry file. It is separate from Git's `main` branch.

## Choose a demonstration

Run one of these from the repository root:

| Command | What starts |
|---|---|
| `npm.cmd start` | Database, module, recorded snapshot, ML inference, forecasts, cost/field policy, and frontend |
| `npm.cmd start -- --mock` | Database, live mock water producer, ML/forecast/decision updates, and frontend |
| `npm.cmd start -- --port COM3` | Database, receive-only Arduino bridge on the specified port, and frontend |
| `npm.cmd start -- --dataset data/HackUTD-ZeroDay/history/snapshot_2026-10-09T0330` | The same complete stack using another dataset folder |
| `npm.cmd start -- --help` | Startup options without starting any services |

`node main.mjs` is also supported on the tested Windows Node installation. Use `npm.cmd start` as the standard command. Dataset paths are relative to `backend/`, where the loader runs.

The dashboard's **DECISIONS & ML** panel can switch to the snapshot, start/stop its own water mock, and load **Demo: all at risk**. Loading a new source starts a new simulation session. **UI SAMPLES** and **CUSTOM SAMPLES** are the original frontend's separate local sample modes; select **BACKEND** for authoritative database updates.

In water-mock mode, level starts at 55%, reaches the 85% warning, and then reaches the fictional 92% threshold. The selected-facility strip shows estimated time until shutdown when enough fresh evidence exists. Tabletop forecasts use **seconds**; field forecasts use **hours/minutes**. Draining, missing, stale and ambiguous data are labeled explicitly.

The complete-field rule automatically latches when all producing facilities have usable threshold forecasts inside the horizon, or a complete stop is cheapest among the modeled strategies. Fault forecasts also respect expected repair. All modeled well production goes to zero; observations and sensors remain intact. Acknowledgement does not restart production, and a reviewed restart is rejected while its condition remains active. Extra operating/shutdown/restart costs are explicit demo assumptions, defaulting to zero.

## Arduino setup

The hardware teammate must verify sensor models/pins and calibrate the container using `backend/arduino/ghidorah_sensor/ghidorah_sensor.ino`. The supplied sketch initially emits a null level until `CALIBRATION_CONFIRMED` is set after calibration. Upload it manually in Arduino IDE. Close Serial Monitor before starting the bridge.

List ports from the repository root:

```powershell
npm.cmd run ports
```

Replace `COM3` with your Arduino's actual port, then start with `npm.cmd start -- --port COM3`. `--tank S2_TANK_A` can override the default mapping to `S1_TANK_A`. The bridge receives JSON at 115200 baud and sends no serial commands. Opening USB may reset some boards. Physical calibration and bench testing remain separate from the automated mock checks.

## Optional second terminal

You do not need multiple terminals to run the dashboard. To inspect console updates, click **+** in PyCharm's Terminal panel and run:

```powershell
cd C:\Users\BF041\OneDrive\Documents\TeamGhidorahHackUTD26
npm.cmd run watch
```

## Stop and restart

Press **Ctrl + C** in the startup terminal. The launcher stops processes it started. A database server that was already running before this command is left running. A normal restart republishes the module and begins a fresh demo session without deleting the database. The standalone serial bridge is not opened unless you explicitly select a port.

## Troubleshooting

| Message | Action |
|---|---|
| Missing `package.json` | Run from `TeamGhidorahHackUTD26`, not its parent directory. |
| Dependencies missing | Run `npm.cmd run setup` from the root and wait for both installations to finish. |
| `spacetime` not recognized | Install the CLI and reopen PyCharm. The launcher also checks the standard Windows CLI location. |
| Missing `network.json` | Run `npm.cmd run data:fetch`; check that your chosen dataset folder contains all three inputs. |
| Port 5173 already in use | Stop the earlier frontend terminal before launching another copy. |
| Frontend disconnected | Wait for **Backend ready**, then use **Reconnect** if needed. Check that both processes are still running. |
| Arduino port busy | Close Arduino Serial Monitor and any earlier bridge. |
| ETA unavailable | Inspect its state: warmup, draining, invalid reading and stale input are valid reasons to withhold an estimate. |

SpacetimeDB may print `tsc not found in node_modules` because it looks for a module-local compiler. The backend's shared type checks run first; a passing check followed by **Build finished successfully** is expected with this layout.

## Verify and explore

```powershell
npm.cmd run check
npm.cmd test
```

For the complete dataset/live-server suite, fetch all practice folders once, then run:

```powershell
npm.cmd run data:fetch -- all
npm.cmd run test:all
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the complete stack/file map, [backend/START_HERE.md](backend/START_HERE.md) for detailed demo behavior, [backend/models/evaluation.json](backend/models/evaluation.json) for ML results, and [backend/VERIFICATION.md](backend/VERIFICATION.md) for checks already performed.

All field shutdowns, decisions and production effects are simulated. No equipment controls are actuated. Offline ML training is an explicit separate task and is not rerun during startup.
