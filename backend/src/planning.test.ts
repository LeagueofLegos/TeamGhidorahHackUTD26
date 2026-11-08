import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptShutdown, evaluatePreventivePlan, optimizeSystem,
  simulatePreventivePlan, validateFleet, type PlanningInput
} from "./planning.js";

const base = (change: Partial<PlanningInput> = {}): PlanningInput => ({
  systemId: "S", facilityId: "F", capacityBbl: 1000, levelPct: 50, shutdownPct: 90,
  repairHours: 6, responseHours: 1, cycleHours: 4,
  truckCapacityBbl: 150, costPerTrip: 100,
  alreadyShutIn: false,
  wells: [
    { id: "cheap", waterBpd: 1200, revenuePerHour: 100, producing: true },
    { id: "valuable", waterBpd: 1200, revenuePerHour: 1000, producing: true }
  ],
  ...change
});
const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test("doing nothing uses only the shutdown-to-repair lost revenue", () => {
  const p = acceptShutdown(base());
  close(p.automaticShutdownAfterHours!, 4);
  close(p.lostRevenue, 2200);
  close(p.totalCost, 2200);
  assert.equal(p.trucks.length, 0);
});

test("no fleet: cheap-well curtailment is delayed and uses hours, not days", () => {
  const r = optimizeSystem("S", [base()], 0);
  assert.equal(r.plans[0].kind, "well_shut_in");
  close(r.totalCost, 400.02);
  close(r.plans[0].wellCuts.find(c => c.wellId === "cheap")!.startAfterHours, 1.9998);
  assert.equal(r.plans[0].wellCuts.length, 1);
});

test("a truck that arrives at the trip instant cannot prevent the trip", () => {
  const r = simulatePreventivePlan(base({ responseHours: 4 }), [], [
    { truckId: "T", dispatchAfterHours: 0, trips: 1 }
  ]);
  assert.equal(r.feasible, false);
});

test("a visit at repair completion is invalid", () => {
  const r = simulatePreventivePlan(base({ responseHours: 6 }), [], [
    { truckId: "T", dispatchAfterHours: 0, trips: 1 }
  ]);
  assert.equal(r.feasible, false);
});

test("partial loads are not invented when the tank contains too little water", () => {
  const r = simulatePreventivePlan(base({ levelPct: 1, responseHours: 0 }), [], [
    { truckId: "T", dispatchAfterHours: 0, trips: 1 }
  ]);
  assert.equal(r.feasible, false);
});

test("one truck returning twice can be cheaper than well curtailment", () => {
  const r = optimizeSystem("S", [base()], 1);
  close(r.totalCost, 200);
  assert.equal(r.plans[0].kind, "trucking");
  assert.equal(r.plans[0].trucks[0].trips, 2);
  assert.deepEqual(r.plans[0].trucks[0].arrivalsAfterHours, [1, 5]);
  close(r.plans[0].trucks[0].freeAfterHours, 9);
});

test("one truck plus a delayed well shut-in beats either option alone", () => {
  const r = optimizeSystem("S", [base({ repairHours: 5.5 })], 1);
  assert.equal(r.plans[0].kind, "mixed");
  close(r.totalCost, 100.02);
  assert.equal(r.plans[0].trucks[0].trips, 1);
});

test("earlier well shut-in can be required before a late truck arrives", () => {
  const input = base({ responseHours: 4.5, truckCapacityBbl: 300, cycleHours: 8 });
  const r = optimizeSystem("S", [input], 1);
  assert.equal(r.plans[0].kind, "mixed");
  close(r.totalCost, 350.02);
  assert.ok(r.plans[0].wellCuts[0].startAfterHours < 4);
  assert.equal(simulatePreventivePlan(input, r.plans[0].wellCuts, r.plans[0].trucks).feasible, true);
});

test("trucks in one plan can have different trip counts", () => {
  const input = base({ levelPct: 70, cycleHours: 3, truckCapacityBbl: 150 });
  const r = optimizeSystem("S", [input], 2);
  assert.equal(r.plans[0].kind, "trucking");
  close(r.totalCost, 300);
  assert.equal(r.plans[0].trucks.reduce((sum, t) => sum + t.trips, 0), 3);
  assert.deepEqual(r.plans[0].trucks.map(t => t.trips).sort(), [1, 2]);
  assert.equal(simulatePreventivePlan(input, r.plans[0].wellCuts, r.plans[0].trucks).feasible, true);
});

test("one physical truck cannot be allocated concurrently to two facilities", () => {
  const a = base({ facilityId: "A", repairHours: 5 });
  const b = base({ facilityId: "B", repairHours: 5 });
  const r = optimizeSystem("S", [a, b], 1);
  assert.equal(validateFleet(r.plans, r.truckIds), true);
  assert.equal(r.plans.filter(p => p.trucks.length > 0).length, 1);
  close(r.totalCost, 300.02);
});

test("a truck can take a second job only after its last round trip returns", () => {
  const a = base({ facilityId: "A", levelPct: 70, repairHours: 3,
    responseHours: 0.5, cycleHours: 1, truckCapacityBbl: 150 });
  const b = base({ facilityId: "B", levelPct: 50, repairHours: 5,
    responseHours: 0.5, cycleHours: 1, truckCapacityBbl: 150 });
  const r = optimizeSystem("S", [a, b], 1);
  assert.equal(validateFleet(r.plans, r.truckIds), true);
  const jobs = r.plans.flatMap(p => p.trucks).sort((x, y) => x.dispatchAfterHours - y.dispatchAfterHours);
  assert.equal(jobs.length, 2);
  assert.ok(jobs[1].dispatchAfterHours >= jobs[0].freeAfterHours - 1e-9);
  close(jobs[1].arrivalsAfterHours[0] - jobs[1].dispatchAfterHours, 0.5);
});

test("already-shut-in production is not magically restarted by trucking", () => {
  const r = optimizeSystem("S", [base({ levelPct: 90, alreadyShutIn: true })], 2);
  assert.equal(r.plans[0].kind, "accept_shutdown");
  assert.equal(r.plans[0].trucks.length, 0);
  close(r.totalCost, 6600);
});

test("repair before the limit costs nothing and needs no response", () => {
  const r = optimizeSystem("S", [base({ repairHours: 2 })], 2);
  close(r.totalCost, 0);
  assert.equal(r.plans[0].kind, "none");
});

test("initially inactive wells contribute unavoidable revenue loss", () => {
  const input = base({ repairHours: 2, wells: [
    { id: "off", waterBpd: 1200, revenuePerHour: 100, producing: false },
    { id: "on", waterBpd: 1200, revenuePerHour: 1000, producing: true }
  ] });
  close(acceptShutdown(input).lostRevenue, 200);
  close(optimizeSystem("S", [input], 0).totalCost, 200);
});

test("zero-water wells do not need to be sacrificed to make storage space", () => {
  const input = base({ wells: [
    { id: "water", waterBpd: 2400, revenuePerHour: 100, producing: true },
    { id: "dry", waterBpd: 0, revenuePerHour: 1000, producing: true }
  ] });
  const r = optimizeSystem("S", [input], 0);
  assert.equal(r.plans[0].wellCuts.some(cut => cut.wellId === "dry"), false);
  assert.ok(r.totalCost < 201);
});

test("bounded searches return a feasible fallback and disclose truncation", () => {
  const input = base({ responseHours: 4.5, truckCapacityBbl: 300 });
  const r = optimizeSystem("S", [input], 1, { maxLinearVertices: 1 });
  assert.equal(r.search.truncated, true);
  assert.ok(r.totalCost <= r.baselineCost);
  assert.equal(validateFleet(r.plans, r.truckIds), true);
});

test("fleet validator detects overlap even between otherwise valid plans", () => {
  const input = base();
  const p = evaluatePreventivePlan(input, [], [{ truckId: "T", dispatchAfterHours: 0, trips: 2 }])!;
  assert.ok(p);
  assert.equal(validateFleet([p, { ...p, facilityId: "other" }], ["T"]), false);
});

test("invalid inputs and cross-system mixing are rejected", () => {
  assert.throws(() => optimizeSystem("S", [base({ repairHours: -1 })], 2));
  assert.throws(() => optimizeSystem("S", [base()], -1));
  assert.throws(() => optimizeSystem("S", [base({ systemId: "other" })], 2));
  assert.throws(() => optimizeSystem("S", [base()], 2, { maxLinearVertices: 0 }));
});

test("continuous shut-in optimization beats an independently enumerated time grid", () => {
  const input = base({ levelPct: 65, cycleHours: 10, wells: [
    { id: "A", waterBpd: 600, revenuePerHour: 80, producing: true },
    { id: "B", waterBpd: 1200, revenuePerHour: 100, producing: true },
    { id: "C", waterBpd: 600, revenuePerHour: 500, producing: true }
  ] });
  // This oracle uses its own water-balance equation, not the planner's simulator.
  let gridBest = Infinity;
  for (let a = 0; a <= 6; a += 0.25) for (let b = 0; b <= 6; b += 0.25) for (let c = 0; c <= 6; c += 0.25) {
    const starts = [a, b, c], rates = [25, 50, 25], revenues = [80, 100, 500];
    const before = 650 + 100 - rates.reduce((sum, q, i) => sum + q * Math.max(0, 1 - starts[i]), 0);
    const end = 650 + 600 - 150 - rates.reduce((sum, q, i) => sum + q * (6 - starts[i]), 0);
    if (before < 150 || before >= 900 || end >= 900) continue;
    gridBest = Math.min(gridBest, 100 + revenues.reduce((sum, revenue, i) => sum + revenue * (6 - starts[i]), 0));
  }
  const result = optimizeSystem("S", [input], 1);
  close(result.totalCost, 500.02);
  assert.ok(result.totalCost <= gridBest);
  assert.equal(result.search.truncated, false);
});
