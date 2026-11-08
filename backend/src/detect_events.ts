import { loadDataset } from "./dataset.js";
import { analyzeDataset } from "./detection.js";
import { planDataset } from "./planning_dataset.js";

const folder = process.argv[2] ?? "data/HackUTD-ZeroDay/history/full_week";
const dataset = await loadDataset(folder);
const asOf = process.argv[3] === undefined ? dataset.nowTs : Date.parse(process.argv[3]) / 1000;
const analysis = analyzeDataset(dataset, asOf);
const costReport = planDataset(dataset, analysis);
const plans = new Map(costReport.systems.flatMap(system =>
  system.status === "unavailable" ? [] : system.result.plans.map(plan => [plan.facilityId, plan] as const)));
const predictions = new Map(analysis.predictions.map(p => [p.facilityId, p]));
const round = (value: number | null | undefined) =>
  value == null ? null : Number(value.toFixed(2));

console.log("SIMULATED DATA — advisory only; no hardware commands.");
console.log("Replay now:", new Date(analysis.nowTs * 1000).toISOString());
console.log("Detected episodes:", analysis.events.length);
console.log("Ongoing alerts:", analysis.alerts.length);

console.table(analysis.alerts.map(event => {
  const p = predictions.get(event.facilityId);
  return {
    facility: event.facilityId,
    category: event.category,
    observedOnset: new Date(event.onsetTs * 1000).toISOString(),
    prediction: p?.state ?? null,
    shutdownHours: round(p?.hoursToShutdown),
    repairHoursLeft: round(p?.repairRemainingHours),
    response: event.category === "pump_failure" ? plans.get(event.facilityId)?.kind ?? "awaiting_planning_data" : "field_inspection",
    modeledCost: event.category === "pump_failure" ? round(plans.get(event.facilityId)?.totalCost) : null
  };
}));

console.table(analysis.events.map(event => ({
  facility: event.facilityId,
  category: event.category,
  status: event.status,
  observedOnset: new Date(event.onsetTs * 1000).toISOString(),
  confirmedAt: new Date(event.detectedAtTs * 1000).toISOString(),
  observedEnd: event.endTs === null ? null : new Date(event.endTs * 1000).toISOString()
})));
