# Run the Ghidorah backend

The stack is TypeScript + Node.js, SpacetimeDB 2.14.1, a React subscription client, and Arduino UNO R4 WiFi through USB serial. The board's WiFi is not required. Python and a separate web API server are not required. PyCharm works as your editor and terminal.

## 1. Open the team project

Open `C:\Users\BF041\OneDrive\Documents\TeamGhidorahHackUTD26` in PyCharm. Open its Terminal tab, then:

```powershell
cd C:\Users\BF041\OneDrive\Documents\TeamGhidorahHackUTD26
git branch --show-current
node --version
spacetime --version
npm.cmd run setup
```

The backend work is on `backend/data-loader`. Node 26.13.0 and SpacetimeDB 2.14.1 were used for verification. The committed lockfile records npm dependencies. Run `git status` before switching branches if you have your own edits.

## 2. Get the challenge data if needed

Your existing ignored data directory can be reused. If the snapshot folder is missing, run this from the team project root:

```powershell
npm.cmd run data:fetch
```

This fetches only `network.json`, `ops.json`, and `telemetry.csv`, pinned to challenge commit `135ba4c8348357457420a1111df80ec1906bcbdb`. It does not fetch answer keys. For all practice folders needed by the full test suite:

```powershell
npm.cmd run data:fetch -- all
```

## 3. Start the complete backend

From the team project root:

```powershell
npm.cmd run dev
```

Keep this terminal open. This starts a local database on `127.0.0.1:3000`, publishes the module, authorizes a local producer, imports the October 8 noon snapshot, and calculates alerts/predictions/plans in the database. Wait for **Backend ready**. S2's cost should be about **$3,120.94**. If an existing local SpacetimeDB server is already on that port, the script uses it; it only stops processes it starts itself. A missing CLI error means restart PyCharm after installing SpacetimeDB so it receives the updated PATH.

Startup runs the project type checks first. SpacetimeDB may then print `tsc not found in node_modules` because the module uses the backend's shared compiler installation; that CLI message is harmless when the preceding type checks pass and the build says successful. The module is still built and published normally.

In a second PyCharm terminal, from the project root:

```powershell
npm.cmd run watch
```

This is a console observer. Your frontend teammate connects the React UI using `backend/FRONTEND.md`. The backend does not include a finished React dashboard. After database schema changes, run `npm.cmd run generate` inside `backend` and refresh the frontend's copy of the generated bindings.

Everything is local, and source data is ignored by Git. Runtime state is stored under `backend/.runtime/`; producer tokens under `backend/.tokens/`. Neither directory should be committed. A normal restart republishes without deleting the database; the import then starts a new demo session. Previously recorded audit entries are retained, subject to a 500-entry demo retention limit.

## 4. Demonstrate live input without hardware

With the database running, use a third terminal:

```powershell
cd C:\Users\BF041\OneDrive\Documents\TeamGhidorahHackUTD26
npm.cmd run mock -- --count 35
```

This starts a new mock session. Level rises from 55% by 1.5 percentage points per second. The tabletop ETA warms up over five samples/four seconds, the 85% warning appears, and 92% latches the fictional trip. After input stops for ten seconds, telemetry becomes stale and countdowns/recommendations are withheld. Acknowledgement never clears the trip. Restarting mock creates a new simulation session.

Alternatively start the server and a continuous mock together with `npm.cmd run dev -- --mock`. This intentionally uses a different scenario from the historical snapshot. For a repeatable short presentation, the 35-sample command above is preferable.

## 5. Connect the Arduino demo

Have the hardware teammate inspect `backend/arduino/ghidorah_sensor/ghidorah_sensor.ino`. The example assumes an HC-SR04-compatible ultrasonic sensor on trigger D2/echo D3, tilt D4, shock D5, water indicator A0. Verify actual module models, voltage compatibility, pinout, polarity, and wet threshold before wiring. Unused digital inputs use pullups. The ultrasonic trigger pin only requests a sensor measurement. There are no actuator outputs.

In Arduino IDE, select **Arduino UNO R4 WiFi** and its COM port. Measure sensor-to-water distance at the empty and full calibration marks. Edit `EMPTY_DISTANCE_CM`, `FULL_DISTANCE_CM`, and only then set `CALIBRATION_CONFIRMED = true`. Until confirmed, the sketch sends a null level and the backend correctly withholds predictions. Keep the ultrasonic sensor dry above the container. Upload the sketch yourself; no script in this project flashes the board. Close Arduino Serial Monitor before starting the bridge.

Find ports, then substitute your actual COM number:

```powershell
npm.cmd run ports
npm.cmd run bridge -- --port COM3
```

The bridge opens USB at 115200 baud and receives newline-delimited JSON:

```json
{
  "device_id": "UNO_R4",
  "water_level_pct": 61.2,
  "wet": false,
  "tilt": false,
  "shock": false
}
```

Use `null` for an invalid level. Wet/tilt/shock are boolean indicators, not vibration severity or health diagnoses. The bridge assigns session, sequence, and receipt timestamps, drops input under backpressure, rejects malformed frames, and never writes serial commands. Opening USB can reset some boards. The default sensor mapping is `S1_TANK_A`; override with `--tank S2_TANK_A` if needed. One producer mode is active at a time. Starting another session invalidates packets from the previous session.

The physical sensor's trend is reported in **seconds**. The fictional field simulation advances **five minutes per accepted packet** and uses configured baseline inflows for field forecasts/costs in **hours**. Other field sensors and all production changes are simulated. This is a demonstration mapping, not a claim that the real water container contains oilfield barrels. Hardware has not been bench-tested by the automated checks.

## 6. Replay or use other snapshots

From `backend`, with the server running:

```powershell
cd backend
npm.cmd run import -- data/HackUTD-ZeroDay/history/snapshot_2026-10-09T0330
npm.cmd run replay
```

Import reconstructs episode history in batches, then publishes the final current state. Replay starts at the beginning of `full_week`, advances one recorded frame per second, and recomputes state at every frame. Set `$env:REPLAY_INTERVAL_MS = '250'` for faster replay. Early quiet portions of the week will have no faults; use snapshot import for an immediate problem demonstration. Historical time does not expire merely because the recording is old.

Your existing standalone commands continue to work from the root:

```powershell
npm.cmd run plan -- data/HackUTD-ZeroDay/history/snapshot_2026-10-08T1200
```

## 7. Verify and learn the pieces

To exercise the separate six-well compressor cost comparison from `backend`, run `npm.cmd run compressor -- --hours 6`. This simulates a trip and prints curtailment, standby, and maintenance costs plus the cheapest feasible action. Add `--no-standby` or `--no-maintenance` to change availability. `npm.cmd run compressor -- --reset` clears a manual simulated trip; a hardware-threshold trip requires a new demo session. No action is physically applied.

From `backend`:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:module
npm.cmd run test:live
```

There are 35 domain tests, 11 dataset integration tests, and nine database reducer tests. The live test additionally starts a separate server on port 3100 with a new test database, imports a real snapshot, connects an independent subscriber, checks the exact S2 cost, scenario isolation, authorization, audit recording, mock warmup, invalid/duplicate readings, trip latch, and scheduled staleness. It stops its own server afterward. `npm.cmd run test:all` runs all checks in sequence. The full practice data must be present for dataset/reducer/live tests.

Read these files in this order:

1. `src/dataset.ts` and `src/configuration.ts`: load and validate the three inputs.
2. `src/detection.ts`: incremental evidence, episode lifecycle, smoothed field forecast.
3. `src/planning.ts` and `src/planning_dataset.ts`: feasible response costs and shared truck allocation.
4. `src/demo.ts`: physical level trend and separate fictional compressor actions.
5. `spacetimedb/src/index.ts`: tables, authorization, atomic reducers, scheduler and audit.
6. `bridge/` and `client/`: receive-only input and live subscriptions.
7. `src/ml.ts`, `src/train_model.ts`, and `models/evaluation.json`: trained model and measured evaluation.

The trained classifier uses running-flow and pressure features to distinguish normal, leak, and pump-degradation samples. Explicit fault status and tank thresholds remain rule-based. Training uses the first 30% of the synthetic practice week; held-out later samples achieve macro F1 about **0.978**. Scores are uncalibrated; this is neither an independent field validation nor a prediction of actual equipment failure. Inference is withheld at/before the training cutoff. Retraining is an explicit offline command: `npm.cmd run train -- <practice-folder> <practice-answer-key.json>`. Labels are never read by the running module, import, planner, bridge, or normal tests.

The Gotham inspiration is the linked asset graph, observation provenance, event timeline, what-if comparison, explainable advice, and recorded operator decisions. There is no Palantir service dependency or integration. This prototype is for a local hackathon presentation: all decisions are advisory, cost search is bounded, sensors are uncalibrated until your hardware teammate calibrates them, and no external hardware controls are actuated.
