import type { Dataset, Reading } from "../src/dataset.js";
export function fixture(): Dataset {
  const network = {
    defaults: { tank_limits_pct: { warning: 85, shutdown: 92 } },
    systems: [
      {
        id: "S",
        disposal_site: { id: "D", lat: 0, lon: 0, pressure_psi: 1000 },
        facilities: [
          {
            id: "F",
            lat: 0,
            lon: 0,
            wells: [
              { id: "W", baseline_water_bpd: 2400, oil_bpd: 24, gas_mcfd: 0 },
            ],
            tank: { id: "T", capacity_bbl: 1000 },
            pump: {
              id: "P",
              max_flow_bpd: 3000,
              start_level_pct: 70,
              stop_level_pct: 30,
            },
            pipeline: { id: "L", max_bpd: 4000, max_pressure_psi: 1700 },
          },
        ],
      },
    ],
  };
  const ops = {
    prices: { oil_per_bbl: 60, gas_per_mcf: 3 },
    expected_repair_hours: { pump_failure: 6 },
    emergency_trucking: { truck_capacity_bbl: 150, cost_per_trip: 905 },
    systems: {
      S: {
        emergency_fleet_size: 2,
        facilities: { F: { response_min: 75, cycle_min: 240 } },
      },
    },
  };
  const readings: Reading[] = [];
  [2, 2, 2, 1, 1].forEach((status, i) => {
    const ts = i * 300;
    for (const [asset_id, metric, value] of [
      ["P", "status", status],
      ["P", "flow_bpd", status === 2 ? 0 : 3000],
      ["L", "receive_flow_bpd", status === 2 ? 0 : 3000],
      ["F", "inflow_bpd", 2400],
      ["T", "level_pct", 50 + i],
    ] as const)
      readings.push({
        asset_id,
        metric,
        value,
        ts_unix: ts,
        timestamp: new Date(ts * 1000).toISOString(),
      });
  });
  return {
    network,
    ops,
    readings,
    folder: "unit-fixture",
    firstTs: 0,
    nowTs: 1200,
    latest: new Map(),
  };
}
