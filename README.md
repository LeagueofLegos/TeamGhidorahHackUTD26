# Oil Field Monitor

A touch-friendly operations monitor for oil-field telemetry. It shows an equipment-flow diagram only while alerts are active, raises red-alert popups, keeps opened alerts in a scrollable dashboard, and records acknowledgement, resolution, and sensor activity in the site log.

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Run the monitor over HTTPS or `localhost` to use Web Serial.

## Sensor inputs

### Dataset files

Choose an Arduino `.ino` sketch by itself to load it as a firmware reference, or choose `network.json`, `ops.json`, and `telemetry.csv` together to load telemetry. You may include one `.ino` file in the same selection. The CSV format is:

```csv
timestamp,ts_unix,asset_id,metric,value
2026-10-05T00:00:00Z,1791158400,S1_TANK_A,level_pct,84.5
```

The monitor validates asset IDs, metric types, timestamps, status values, and tank levels before processing. Files are limited to 100 MB each and 2,000,000 telemetry rows. The provided `network.json` and `ops.json` are used as the default asset map and operating context for a serial connection. The app does not load answer-key files.

### Arduino sketch and Web Serial

Loading an `.ino` file does not compile, execute, or upload it to the board. Connect the flashed Arduino with **Connect sensor** and grant access to its serial device. Choose the tank connected to the overflow sensor. The board should print one of these newline-delimited outputs at 115200 baud:

```text
OVERFLOW
NORMAL
```

`OVERFLOW` or `OVERFLOW: 1` raises a red alert; `NORMAL`, `GREEN`, `CLEAR`, `NO OVERFLOW`, or `OVERFLOW: 0` returns the tank to normal. Percent-level output such as `Tank level: 42%` is also supported and uses the configured warning/shutdown limits. Distance-only output is not interpreted because the tank's sensor-to-overflow calibration is hardware-specific.

JSON telemetry is also supported:

```json
{"timestamp":"2026-10-05T00:00:00Z","ts_unix":1791158400,"asset_id":"S1_TANK_A","metric":"level_pct","value":84.5}
```

Use the asset IDs and supported metric names in `network.json` and the telemetry dataset. The browser requests the port only after the user selects **Connect sensor**; it cannot silently attach to hardware. Disconnect the sensor from the UI when finished.

A tank overflow contact can report `{"asset_id":"S1_TANK_A","metric":"overflow","value":1,"ts_unix":1791158400}` to raise a red alarm; `value: 0` reports that the contact is clear. A stale serial feed is shown as stale rather than all clear.

## Alert behavior

- Tank fill at or above the configured warning limit (85% in the supplied network) raises a yellow warning. At the configured shutdown limit (92%), the monitor raises a red alert and reports the documented well shut-in procedure.
- A pump fault status raises a red alert. Sustained pipeline pressure loss and low pump discharge pressure are detected using the operating offsets described in the project specification.
- Red alerts open a popup and play the enabled siren. Browser audio must first be enabled by the user.
- Opened alerts remain in the side dashboard. Acknowledging removes an alert from active display; **Solved** in the site log reports it green. Normal telemetry clears an alert when its detected condition is no longer present.
- Cost growth is a production-at-risk estimate based on configured well output and commodity prices. It is not a site-specific accounting value.

This application is a read-only monitor. It does not issue shutdown, pump, or other equipment-control commands. Follow site procedures and approved control and safety systems for real operations.

## SpacetimeDB state sync

The TypeScript module in `spacetimedb/` stores each user's live alert state and recent activity. Its caller-filtered views and `sync_feed` reducer provide the browser persistence and synchronization path. The module must be published before the frontend can sync; build and binding generation do not publish it.

### Local development server

The browser must use the same server and database where the module was published. To run locally, start a local server in one terminal and leave it running:

```sh
spacetime start --listen-addr 127.0.0.1:3000
```

In another terminal, publish the module to that local server:

```sh
spacetime publish --server local --module-path spacetimedb thirsty-volcano-3675
```

The ignored `.env.local` should point Vite at the local WebSocket server and the same database name:

```env
VITE_SPACETIMEDB_URI=ws://127.0.0.1:3000
VITE_SPACETIMEDB_DB_NAME=thirsty-volcano-3675
```

Restart `npm run dev` after changing `.env.local`. Check that the page reports **DATABASE CONNECTED**. If the browser URL still shows `wss://maincloud.spacetimedb.com`, Vite did not load the local override.

### Maincloud

Maincloud is a separate deployment. Authenticate with the SpacetimeDB CLI, confirm the database exists, then publish the module explicitly with `--server maincloud`. Set `VITE_SPACETIMEDB_URI=wss://maincloud.spacetimedb.com` and the matching database name in `.env.local`; restart Vite afterward. Do not mix a local server URL with a Maincloud database (or vice versa).

```sh
spacetime build
spacetime generate --lang typescript --module-path spacetimedb --out-dir src/module_bindings --import-extension js
```

## Checks

```sh
npm test
npm run build
```
