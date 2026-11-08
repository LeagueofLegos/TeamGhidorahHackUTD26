import { loadDataset } from "./dataset.js";
import { analyzeDataset } from "./detection.js";
import { planDataset } from "./planning_dataset.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
if (args.some(arg => arg.startsWith("--") && arg !== "--json")) throw new Error("Only --json is supported.");
const positions = args.filter(arg => arg !== "--json");
const dataset = await loadDataset(positions[0] ?? "data/HackUTD-ZeroDay/history/full_week");
const at = positions[1] === undefined ? dataset.nowTs : Date.parse(positions[1]) / 1000;
const analysis = analyzeDataset(dataset, at);
const report = planDataset(dataset, analysis);
const round = (value: number) => Number(value.toFixed(2));
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("SIMULATED ADVISORY PLANS — no equipment or truck dispatch commands.");
  console.log("Planning time:", new Date(report.nowTs * 1000).toISOString());
  console.log(report.basis);
  for (const system of report.systems) {
    if (system.status === "unavailable") {
      console.log(system.systemId, "PLANNING UNAVAILABLE:", system.reasons.join(" "));
      continue;
    }
    if (system.status === "no_failures") continue;
    const result = system.result;
    console.log(`\n${system.systemId}: $${result.totalCost.toFixed(2)} modeled cost; $${result.savings.toFixed(2)} saved versus accepting shutdowns.`);
    console.log(result.search.scope);
    console.log("Search:", result.search.truncated ? "LIMIT REACHED — feasible best found" : "completed enumerated search",
      `(${result.search.states} states; ${result.search.linearVertices} linear vertices)`);
    console.table(result.plans.map(plan => ({
      facility: plan.facilityId, action: plan.kind,
      repairHoursLeft: round(plan.horizonHours),
      truckCost: round(plan.truckCost), lostRevenue: round(plan.lostRevenue), totalCost: round(plan.totalCost),
      wellShutIns: plan.wellCuts.map(cut => `${cut.wellId} at +${(cut.startAfterHours * 60).toFixed(2)} min`).join("; "),
      trucks: plan.trucks.map(truck => `${truck.truckId}: ${truck.trips} trip(s), call +${(truck.dispatchAfterHours * 60).toFixed(2)} min, free +${(truck.freeAfterHours * 60).toFixed(2)} min`).join("; ")
    })));
  }
}
