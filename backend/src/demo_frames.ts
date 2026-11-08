import type { Network, Reading } from "./dataset.js";
export function allAtRiskFrames(
  network: Network,
  startTs: number,
): Reading[][] {
  return [0, 1, 2].map((i) => {
    const ts = startTs + i * 300,
      rows: Reading[] = [];
    const add = (asset_id: string, metric: string, value: number) =>
      rows.push({
        asset_id,
        metric,
        value,
        ts_unix: ts,
        timestamp: new Date(ts * 1000).toISOString(),
      });
    for (const sys of network.systems)
      for (const f of sys.facilities) {
        let inflow = 0;
        for (const w of f.wells) {
          add(w.id, "status", 1);
          add(w.id, "water_bpd", w.baseline_water_bpd);
          inflow += w.baseline_water_bpd;
        }
        add(f.id, "inflow_bpd", inflow);
        add(f.tank.id, "level_pct", 85 + i);
        add(f.pump.id, "status", 2);
        add(f.pump.id, "flow_bpd", 0);
        add(f.pump.id, "discharge_psi", 0);
        add(f.pipeline.id, "receive_flow_bpd", 0);
        add(f.pipeline.id, "pressure_psi", 0);
      }
    return rows;
  });
}
