# Connected frontend

The working UI is now in repository `frontend/`, adapted from the team frontend branch (revision in `frontend/SOURCE.md`). Run root `npm.cmd run setup`, then `npm.cmd run dev`, and open http://127.0.0.1:5173. It imports `backend/client/connect.ts` directly. No copy of bindings is necessary for this integrated layout.

The Vite development server authorizes a browser identity through a same-origin loopback-only POST using the local publisher. Demo source controls and actions work locally without hardcoding a writer token. A static deployment has no such development routes and requires a separate authenticated operator workflow.

`frontend/src/backend.js` manages connection/reconnection and actions; `backendAdapter.js` maps authoritative observations to the original UI; `BackendPanel.jsx` displays strategies, model evidence, warning forecasts, effective well production and the field latch. Local UI sample modes stay separate from backend mode.

The following API details also support other React clients:


The backend is a local SpacetimeDB 2.14.1 service. Use `spacetimedb@2.14.1` in the React app. There is no additional REST server or polling layer to maintain.

Keep `backend/client/` and its generated `module_bindings/` together. Import the browser-compatible `connect.ts` helper from the React app, or copy that entire directory into the app. The helper has no Node imports. If Vite imports it across project directories, allow the repository parent in Vite's `server.fs.allow`; alternatively copy the directory into `frontend/src/ghidorah/`. Regenerate bindings with `npm run generate` from backend whenever the database schema changes, then update the frontend copy.

```tsx
import { useEffect, useState } from "react";
import { connect, onSnapshot, type DbConnection } from "./ghidorah/connect";
type View = Parameters<Parameters<typeof onSnapshot>[1]>[0];
export function useGhidorah() {
  const [view, setView] = useState<View>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let connection: DbConnection | undefined;
    let cleanup: (() => void) | undefined;
    connect({
      uri: "ws://127.0.0.1:3000",
      database: "ghidorah-demo",
      token: localStorage.getItem("ghidorah-token") ?? undefined,
      onToken: (token) => localStorage.setItem("ghidorah-token", token),
      onDisconnect: () =>
        setError("Disconnected. Reconnect to refresh live state."),
    })
      .then((conn) => {
        if (disposed) {
          conn.disconnect();
          return;
        }
        connection = conn;
        cleanup = onSnapshot(conn, setView);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      cleanup?.();
      connection?.disconnect();
    };
  }, []);
  return { view, error };
}
```

Public subscriptions are read-only by default. Display a disconnected banner and suppress live countdown/action buttons after disconnection, even if cached data is still present. Numeric optional values are `undefined` when unavailable, never treat them as zero.

| Data                              | Use                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `state`                           | Mode, session, revision, status, model clock, last receive time, demo notice                |
| `entities`, `edges`               | Linked asset graph; coordinates and configuration JSON                                      |
| `sensors`                         | Current complete frame; model timestamp and measurement provenance                          |
| `events`, `alerts`                | Historical episodes, active alerts, acknowledgement                                         |
| `predictions`                     | Field forecast in **hours**; states include insufficient data and stale                     |
| `hardware`, `hardwarePredictions` | Real/mock level, switches, freshness; physical forecast in **seconds**                      |
| `recommendations`                 | One coordinated plan per system, comparisons and explanation in JSON                        |
| `ml`                              | Running-pump classifier scores; explicitly uncalibrated; unavailable before training cutoff |
| `scenarios`                       | What-if report and `baseRevision`; show as outdated when state revision differs             |
| `compressor`, `compressorActions` | Separate fictional six-well compressor demonstration and cost actions                       |

The `json` fields contain detailed structured payloads. Use `JSON.parse(row.json)`. The recommendation JSON includes `result.plans`, `result.comparisons`, `result.search`, and `basis`. Always display search truncation/scope and cost assumptions. Standalone alternatives cannot be combined independently across systems sharing trucks. Inspection alerts do not have a supplied inspection price.

During `loading`, suppress recommendations until the final `ready` update. Current values always represent one complete supplied timestamp; omitted sensors do not silently inherit an older value. Opt into `connect({history: true})` and read `conn.db.sensorReading` for retained observation history. That table is bounded to 3,000 rows. Batch import stores the final frame of each batch in this history table while processing **every** frame through detection; it is a sampled history, not a copy of the full CSV. One-frame replay/hardware updates retain every received frame until the retention limit. Events retain up to roughly 2,000 episodes; audit retains 500 entries.

Scenario changes accept `oilPrice`, `gasPrice`, `repairHours`, and `fleetSize`. `repairHours` means total expected fault-to-repair duration, so elapsed time since the observed onset is subtracted. It is not an additional number of hours from now. Compressor comparison uses its own explicit horizon in `config.horizonHours`.

Keep the persistent demo notice visible. Mark hardware-mapped level as measured, challenge telemetry as synthetic, and all field production/protective trips as simulated. The hardware trend in seconds and baseline field cost model in hours are different estimates.

Writer buttons, if wanted, call the generated reducers:

```ts
await conn.reducers.acknowledgeAlert({ id: alertId });
await conn.reducers.compareScenario({
  id: "no-trucks",
  json: JSON.stringify({ fleetSize: 0 }),
});
await conn.reducers.recordDecision({
  systemId: "S2",
  revision: currentRevision,
  note: "Demo plan reviewed",
});
// Copy the complete config from JSON.parse(compressorRow.json).config:
await conn.reducers.simulateCompressor({
  tripped: true,
  configJson: JSON.stringify(config),
});
```

Writer authorization is explicit: obtain the frontend identity from `conn.identity.toHexString()`, then the publisher runs this from backend using the same local runtime:

```powershell
spacetime --root-dir .runtime call --server http://127.0.0.1:3000 ghidorah-demo grant_writer '"IDENTITY_HEX"' true
```

Never copy a writer token into source code. Acknowledging an alert records review; it does not repair equipment or clear a latched demo trip. Decisions only create audit records. Starting a new import/mock/bridge session resets the simulation and invalidates old producer sessions. These reducers provide no equipment-command API.

## New tables and reducers

`warning_forecast` exposes warning-state field hours until threshold. `field_control` exposes policy, comparable strategy costs, reason and original latched decision. `well_production` and `asset_operation` expose effective simulated state while original measurements remain unchanged. `setFieldPolicy({json})` changes explicit demo assumptions; `resetField({revision,reason})` requires fresh data and rejects active conditions. `snapshot()` includes all four tables and audit rows. ML payloads include `state`, `label`, `rawLabel`, `scores`, `topScore`, `margin`, `evidence` and `reason`. Uncertain, out-of-distribution, unobservable and pre-cutoff states must not be displayed as normal. Temperature is fit on synthetic validation data, never advertised as a physical fault probability.
