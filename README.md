# North Pier 04 Site Monitor

A touch-friendly, full-screen oil-rig monitoring UI prototype. The site plan covers a sample 160-, 400-, or 640-acre area and shows mock equipment sensors, plain-language alerts, and a recent activity log.

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`).

## SpacetimeDB state sync

The TypeScript module in `spacetimedb/` stores each user's simulated and Live Sim feeds separately. Feed settings, sensors, alert acknowledgements, and recent activity are written through the `sync_feed` reducer. Private tables are exposed to clients only through views filtered to the caller's identity.

Build the module and regenerate the client bindings after changing its schema:

```sh
spacetime build
spacetime generate --lang typescript --module-path spacetimedb --out-dir src/module_bindings --import-extension js
```

The frontend connects to `wss://maincloud.spacetimedb.com` and the database configured in `spacetime.local.json` by default. Override these with `VITE_SPACETIMEDB_URI` and `VITE_SPACETIMEDB_DB_NAME` when running Vite. The module must be published to that database before the frontend can sync; build and binding generation above do not publish it.

## Try the prototype

- Tap a generated sensor marker to see its sample reading and, when needed, a suggested next step.
- Use **All sensors** / **Needs attention** to filter the site plan.
- Change the site boundary size or zoom the plan.
- **Simulated** and **Live Sim** are independent feeds, like separate tabs. Alerts, map positions, acknowledgements, and activity in one do not appear in the other. Live Sim does not generate alerts automatically; use **Create alert** to enter a custom alert, its severity and details, response time, cost-growth rate, and any number of potential solutions. In Simulated, **Random alert** adds one sample alert on demand; **Auto alerts: ON/OFF** separately enables or pauses periodic sample alerts and is off by default. Neither feed is connected to real equipment.
- Each alert stores its severity as a numeric level: green = 1, yellow = 2, red = 3. Its level remains fixed until the alert's simulated data changes it; colors and icons are derived from that level. Multi-level changes such as green to red (+2) or red to green (-2) are supported by the model.
- In Simulated, **Delete last alert** removes the most recently generated sample alert.
- Emergency alerts appear immediately without a sound-permission popup. Sound is off until enabled from the header; it can also be tested or muted there.
- Red demo emergencies open in a full-screen alert view, ordered by simulated cost growth. Up to four can be displayed at once.
- Emergency timers appear in red pop-ups. Sensor icons show a shrinking urgency ring instead of a text countdown; acknowledging an alert removes its ring.
- Potential response costs are shown in US dollars. The S1 Pump C sample uses the HackUTD opening-scene figures: $905 for one truck trip, $1,958 for shutting in one well, and $5,016 for doing nothing. Selecting an option only records a choice in the demo; it never dispatches trucks or controls equipment.
- Use **View in alert panel** to move an emergency aside. **Acknowledge alert** marks the demo record complete and stops that example timer; it does not mean the condition is safe or resolved.
- On a narrow display, switch between the alert, sensor, and site-log tabs below the site plan.
- Taps show a brief visual ring, including on non-actionable display areas.

## Important

Readings, urgency windows, generated alerts, and actions are simulated training examples. The three S1 Pump C cost figures are taken from the HackUTD sample scenario and are not estimates for another site or current prices. The demo has no live sensor connection and cannot monitor, acknowledge, dispatch, or control real rig equipment. It is not an emergency notification or safety system. Follow site procedures and approved safety systems for real operations.
