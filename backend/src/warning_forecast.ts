import type { Network, Reading } from "./dataset.js";
export type TankContext = {
  lastTs: number | null;
  samples: Record<string, { ts: number; netBpd: number }[]>;
};
export const createTankContext = (): TankContext => ({
  lastTs: null,
  samples: {},
});
export function advanceTankContext(
  c: TankContext,
  network: Network,
  rows: Reading[],
) {
  if (!rows.length) return;
  const ts = rows[0].ts_unix;
  if (c.lastTs !== null && ts <= c.lastTs)
    throw new Error("Tank forecast frames must increase");
  const frame = new Map(
    rows.map((r) => [`${r.asset_id}/${r.metric}`, r.value]),
  );
  for (const sys of network.systems)
    for (const f of sys.facilities) {
      const inflow = frame.get(`${f.id}/inflow_bpd`),
        outflow = frame.get(`${f.pump.id}/flow_bpd`),
        status = frame.get(`${f.pump.id}/status`);
      let window = c.samples[f.id] ?? [];
      if (window.at(-1) && ts - window.at(-1)!.ts > 600) window = [];
      if (
        inflow === undefined ||
        outflow === undefined ||
        status === undefined
      ) {
        delete c.samples[f.id];
        continue;
      }
      c.samples[f.id] = [...window, { ts, netBpd: inflow - outflow }].filter(
        (r) => ts - r.ts <= 1800,
      );
    }
  c.lastTs = ts;
}
export function warningForecasts(
  c: TankContext,
  network: Network,
  rows: Reading[],
  asOfTs: number,
  quality = "ready",
) {
  const current = new Map(
    rows.map((r) => [`${r.asset_id}/${r.metric}`, r.value]),
  );
  return network.systems.flatMap((sys) =>
    sys.facilities.flatMap((f) => {
      const level = current.get(`${f.tank.id}/level_pct`),
        limits = network.defaults.tank_limits_pct;
      if (level === undefined || level < limits.warning) return [];
      const samples = (c.samples[f.id] ?? []).filter(
          (s) => asOfTs - s.ts <= 1800,
        ),
        last = samples.at(-1);
      const base = {
        id: f.tank.id,
        facilityId: f.id,
        levelPct: level,
        warningPct: limits.warning,
        shutdownPct: limits.shutdown,
        sampleCount: samples.length,
        netInflowBblPerHour: null as number | null,
        hoursToShutdown: null as number | null,
        basis:
          "No-action estimate from current tank volume and median observed inflow minus pump outflow. Assumes current flow continues; planned repairs, pump cycling and interventions can change it.",
      };
      if (quality !== "ready" || c.lastTs !== asOfTs)
        return [
          {
            ...base,
            state: quality === "ready" ? "insufficient_data" : quality,
            reason: "Fresh flow and level evidence are required.",
          },
        ];
      if (level >= limits.shutdown)
        return [
          {
            ...base,
            state: "at_shutdown",
            hoursToShutdown: 0,
            reason: "Observed fictional shutdown threshold has been reached.",
          },
        ];
      if (!last || asOfTs - last.ts > 600)
        return [
          {
            ...base,
            state: "insufficient_data",
            reason: "Warning active; fresh flow observations are missing.",
          },
        ];
      if (last.netBpd <= 0)
        return [
          {
            ...base,
            state: "not_filling",
            netInflowBblPerHour: last.netBpd / 24,
            reason:
              "The latest observed flow balance is steady or draining; a positive historical median does not establish a current shutdown countdown.",
          },
        ];
      if (samples.length < 3 || last.ts - samples[0].ts < 600)
        return [
          {
            ...base,
            state: "insufficient_data",
            reason:
              "Warning active; waiting for three flow samples spanning ten field minutes.",
          },
        ];
      const sorted = samples.map((s) => s.netBpd).sort((a, b) => a - b),
        i = Math.floor(sorted.length / 2),
        rate =
          (sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2) /
          24;
      if (rate <= 0)
        return [
          {
            ...base,
            state: "not_filling",
            netInflowBblPerHour: rate,
            reason:
              "Tank is steady or draining under the observed flow balance; no finite shutdown ETA.",
          },
        ];
      return [
        {
          ...base,
          state: "rising",
          netInflowBblPerHour: rate,
          hoursToShutdown:
            (f.tank.capacity_bbl * (limits.shutdown - level)) / 100 / rate,
          reason:
            "Warning active; estimated time to the fictional shutdown threshold if current flow continues.",
        },
      ];
    }),
  );
}
