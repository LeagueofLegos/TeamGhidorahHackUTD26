import type { Dataset } from "./dataset.js";
import { analyzeDataset } from "./detection.js";
import { optimizeSystem, type PlanningInput, type PlanningOptions } from "./planning.js";

type Available = {
  systemId: string;
  status: "planned" | "no_failures";
  result: ReturnType<typeof optimizeSystem>;
};
type Unavailable = { systemId: string; status: "unavailable"; reasons: string[] };
export type PlanningReport = {
  nowTs: number;
  systems: (Available | Unavailable)[];
  advisoryOnly: true;
  basis: string;
};

export function planDataset(dataset: Dataset, analysis = analyzeDataset(dataset),
  options: PlanningOptions = {}): PlanningReport {
  const latest = new Map<string, { ts: number; value: number }>();
  const key = (id: string, metric: string) => JSON.stringify([id, metric]);
  let frameTs = -Infinity;
  for (const row of dataset.readings) {
    if (row.ts_unix > analysis.nowTs) break;
    latest.set(key(row.asset_id, row.metric), { ts: row.ts_unix, value: row.value });
    frameTs = row.ts_unix;
  }
  const current = (id: string, metric: string) => {
    const row = latest.get(key(id, metric));
    return row?.ts === analysis.nowTs ? row.value : null;
  };
  const systems: PlanningReport["systems"] = dataset.network.systems.map(system => {
    const failures = analysis.alerts.filter(event => event.systemId === system.id && event.category === "pump_failure");
    const reasons: string[] = [];
    const inputs: PlanningInput[] = [];
    if (failures.length && frameTs !== analysis.nowTs) {
      reasons.push("Planning requires a complete telemetry timestamp. Choose a recorded frame instead of an extrapolated time.");
    }
    for (const event of failures) {
      const facility = system.facilities.find(item => item.id === event.facilityId);
      const prediction = analysis.predictions.find(item => item.facilityId === event.facilityId);
      if (!facility || !prediction) { reasons.push(`Missing failure state for ${event.facilityId}.`); continue; }
      const level = current(facility.tank.id, "level_pct");
      const flow = current(facility.pump.id, "flow_bpd");
      if (level === null || flow === null || current(facility.pump.id, "status") !== 2 ||
          current(facility.id, "inflow_bpd") === null || prediction.state === "stale") {
        reasons.push(`Fresh fault, flow, and tank readings are required for ${facility.id}.`); continue;
      }
      if (flow > 1) {
        reasons.push(`${facility.id}: fault telemetry still shows pumping. The stopped-pump planning model is not applicable.`); continue;
      }
      if (prediction.repairRemainingHours <= 0 || prediction.repairRemainingHours > 168) {
        reasons.push(`${facility.id}: repair is overdue or outside the supported seven-day horizon. Confirm the repair estimate.`); continue;
      }
      const wells = facility.wells.map(well => {
        const status = current(well.id, "status");
        const water = current(well.id, "water_bpd");
        if (status === null || water === null) reasons.push(`Missing current well readings for ${well.id}.`);
        return {
          id: well.id, waterBpd: well.baseline_water_bpd,
          revenuePerHour: (well.oil_bpd * dataset.ops.prices.oil_per_bbl + well.gas_mcfd * dataset.ops.prices.gas_per_mcf) / 24,
          producing: status === 1
        };
      });
      const travel = dataset.ops.systems[system.id].facilities[facility.id];
      inputs.push({
        systemId: system.id, facilityId: facility.id,
        capacityBbl: facility.tank.capacity_bbl, levelPct: level,
        shutdownPct: dataset.network.defaults.tank_limits_pct.shutdown,
        repairHours: prediction.repairRemainingHours,
        responseHours: travel.response_min / 60, cycleHours: travel.cycle_min / 60,
        truckCapacityBbl: dataset.ops.emergency_trucking.truck_capacity_bbl,
        costPerTrip: dataset.ops.emergency_trucking.cost_per_trip,
        alreadyShutIn: level >= dataset.network.defaults.tank_limits_pct.shutdown || wells.every(well => !well.producing),
        wells
      });
    }
    if (reasons.length) return { systemId: system.id, status: "unavailable", reasons };
    try {
      return {
        systemId: system.id, status: failures.length ? "planned" : "no_failures",
        result: optimizeSystem(system.id, inputs, dataset.ops.systems[system.id].emergency_fleet_size, options)
      };
    } catch (error) {
      return { systemId: system.id, status: "unavailable", reasons: [String(error)] };
    }
  });
  return {
    nowTs: analysis.nowTs, systems, advisoryOnly: true,
    basis: "Observed tank volume; configured baseline well water rates; fixed production values; stopped failed pumps; expected repair time remaining. Source telemetry is never changed."
  };
}
