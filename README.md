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

Choose `network.json`, `ops.json`, and `telemetry.csv` together with **Load data**. The CSV format is:

```csv
timestamp,ts_unix,asset_id,metric,value
2026-10-05T00:00:00Z,1791158400,S1_TANK_A,level_pct,84.5
```

The monitor validates asset IDs, metric types, timestamps, status values, and tank levels before processing. Files are limited to 100 MB each and 2,000,000 telemetry rows. The provided `network.json` and `ops.json` are used as the default asset map and operating context for a serial connection. The app does not load answer-key files.

### Web Serial

Select **Connect sensor** and grant access to the intended serial device. The device must send one newline-delimited JSON object per reading at 115200 baud:

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

```sh
spacetime build
spacetime generate --lang typescript --module-path spacetimedb --out-dir src/module_bindings --import-extension js
```

The frontend connects to `wss://maincloud.spacetimedb.com` and the database configured in `spacetime.local.json` by default. Override these with `VITE_SPACETIMEDB_URI` and `VITE_SPACETIMEDB_DB_NAME` when running Vite.

## Checks

```sh
npm test
npm run build
```
