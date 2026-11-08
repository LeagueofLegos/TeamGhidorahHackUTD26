import { loadDataset, currentValue } from "./dataset.js";

const folder =
  process.argv[2] ??
  "data/HackUTD-ZeroDay/history/full_week";

const dataset = await loadDataset(folder);
const limits = dataset.network.defaults.tank_limits_pct;

// Round for display only. Calculations retain full precision.
const display = (value: number | null): number | null =>
  value === null ? null : Number(value.toFixed(2));

const summaries = dataset.network.systems.flatMap(system =>
  system.facilities.map(facility => {
    const capacityBbl = facility.tank.capacity_bbl;

    const levelPct = currentValue(
      dataset,
      facility.tank.id,
      "level_pct"
    );

    const inflowBpd = currentValue(
      dataset,
      facility.id,
      "inflow_bpd"
    );

    const pumpFlowBpd = currentValue(
      dataset,
      facility.pump.id,
      "flow_bpd"
    );

    const pumpStatus = currentValue(
      dataset,
      facility.pump.id,
      "status"
    );

    const currentVolumeBbl =
      levelPct === null
        ? null
        : capacityBbl * levelPct / 100;

    const shutdownVolumeBbl =
      capacityBbl * limits.shutdown / 100;

    const remainingBbl =
      currentVolumeBbl === null
        ? null
        : Math.max(0, shutdownVolumeBbl - currentVolumeBbl);

    const baselineWaterBpd = facility.wells.reduce(
      (total, well) => total + well.baseline_water_bpd,
      0
    );

    const nominalRevenuePerHour = facility.wells.reduce(
      (total, well) =>
        total +
        well.oil_bpd * dataset.ops.prices.oil_per_bbl +
        well.gas_mcfd * dataset.ops.prices.gas_per_mcf,
      0
    ) / 24;

    const complete =
      levelPct !== null &&
      inflowBpd !== null &&
      pumpFlowBpd !== null &&
      pumpStatus !== null;

    const netInflowBblPerHour =
      inflowBpd === null || pumpFlowBpd === null
        ? null
        : (inflowBpd - pumpFlowBpd) / 24;

    let countdownState = "missing_telemetry";
    let hoursToShutdown: number | null = null;

    if (complete) {
      if (levelPct >= limits.shutdown) {
        countdownState = "at_shutdown";
        hoursToShutdown = 0;
      } else if (pumpStatus === 2) {
        if (netInflowBblPerHour! > 0) {
          countdownState = "pump_fault";

          hoursToShutdown =
            remainingBbl! / netInflowBblPerHour!;
        } else {
          countdownState = "no_positive_net_inflow";
        }
      } else {
        // Healthy pumps normally cycle off.
        // A rising tank level alone does not establish a failure.
        countdownState = "normal_cycle";
      }
    }

    return {
      systemId: system.id,
      facilityId: facility.id,
      tankId: facility.tank.id,
      capacityBbl,
      levelPct,
      warningVolumeBbl: capacityBbl * limits.warning / 100,
      shutdownVolumeBbl,
      currentVolumeBbl,
      remainingBbl,
      baselineWaterBpd,
      nominalRevenuePerHour,
      inflowBpd,
      pumpFlowBpd,
      pumpStatus,
      countdownState,
      hoursToShutdown
    };
  })
);

console.log(
  "SIMULATED DATA — advisory only; no hardware commands."
);

console.log("Dataset:", dataset.folder);
console.log("Readings:", dataset.readings.length);

console.log(
  "First timestamp:",
  new Date(dataset.firstTs * 1000).toISOString()
);

console.log(
  "Replay now:",
  new Date(dataset.nowTs * 1000).toISOString()
);

console.table(
  summaries.map(item => ({
    facility: item.facilityId,
    levelPct: item.levelPct,
    waterBbl: display(item.currentVolumeBbl),
    remainingBbl: display(item.remainingBbl),
    pumpStatus: item.pumpStatus,
    revenuePerHour: display(item.nominalRevenuePerHour),
    state: item.countdownState,
    shutdownHours: display(item.hoursToShutdown)
  }))
);

// Optional second argument: print full detail for a selected tank.
const selectedTank = process.argv[3];

if (selectedTank) {
  const selected = summaries.find(
    item => item.tankId === selectedTank
  );

  if (!selected) {
    throw new Error(`Unknown tank: ${selectedTank}`);
  }

  console.log(JSON.stringify(selected, null, 2));
}