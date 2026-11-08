import type { Dataset } from "./dataset.js";
import type { analyzeDataset } from "./detection.js";
import type { PlanningReport } from "./planning_dataset.js";
import type { FacilityPlan } from "./planning.js";
export type FieldPolicy = {
  enabled: boolean;
  horizonHours: number;
  avoidableOperatingCostPerHour: number;
  shutdownCost: number;
  restartCost: number;
  minimumSaving: number;
};
export const DEFAULT_FIELD_POLICY: FieldPolicy = {
  enabled: true,
  horizonHours: 6,
  avoidableOperatingCostPerHour: 0,
  shutdownCost: 0,
  restartCost: 0,
  minimumSaving: 0.01,
};
export function validateFieldPolicy(p: FieldPolicy) {
  if (
    !p ||
    typeof p.enabled !== "boolean" ||
    Object.keys(DEFAULT_FIELD_POLICY).some(
      (k) =>
        k !== "enabled" &&
        (typeof p[k as keyof FieldPolicy] !== "number" ||
          !Number.isFinite(p[k as keyof FieldPolicy] as number) ||
          (p[k as keyof FieldPolicy] as number) < 0),
    ) ||
    p.horizonHours <= 0 ||
    p.horizonHours > 168 ||
    p.minimumSaving < 0.01
  )
    throw new Error(
      "Invalid field policy: horizon >0 and <=168 hours; costs >=0; minimum saving >=$0.01",
    );
}
type Analysis = ReturnType<typeof analyzeDataset>;
type Interval = [number, number];
function unionHours(intervals: Interval[]) {
  let hours = 0,
    end = 0;
  for (const [a, b] of intervals.sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    hours += b - Math.max(a, end);
    end = b;
  }
  return hours;
}
export function evaluateField(
  d: Dataset,
  a: Analysis,
  report: PlanningReport,
  p: FieldPolicy,
  quality = "ready",
  warningPredictions: {
    facilityId: string;
    state: string;
    hoursToShutdown: number | null;
  }[] = [],
) {
  validateFieldPolicy(p);
  const h = p.horizonHours,
    frame = new Map(
      d.readings
        .filter((r) => r.ts_unix === a.nowTs)
        .map((r) => [`${r.asset_id}/${r.metric}`, r.value]),
    );
  const get = (id: string, m: string) => frame.get(`${id}/${m}`),
    facilities = d.network.systems.flatMap((sys) => sys.facilities),
    reasons: string[] = [];
  let revenuePerHour = 0,
    producingWells = 0,
    producingFacilities = 0,
    atRiskFacilities = 0;
  const active = new Set<string>();
  for (const f of facilities) {
    let producing = false;
    for (const w of f.wells) {
      const status = get(w.id, "status");
      if (status === undefined)
        reasons.push(`Missing current status for ${w.id}`);
      if (status === 1) {
        producing = true;
        producingWells++;
        revenuePerHour +=
          (w.oil_bpd * d.ops.prices.oil_per_bbl +
            w.gas_mcfd * d.ops.prices.gas_per_mcf) /
          24;
      }
    }
    if (!producing) continue;
    producingFacilities++;
    active.add(f.id);
    const pred = a.predictions.find((x) => x.facilityId === f.id),
      fault = a.alerts.some(
        (e) => e.facilityId === f.id && e.category === "pump_failure",
      );
    const warning = warningPredictions.find((w) => w.facilityId === f.id);
    const warningRisk =
      !!warning &&
      ["rising", "at_shutdown"].includes(warning.state) &&
      warning.hoursToShutdown !== null &&
      warning.hoursToShutdown >= 0 &&
      warning.hoursToShutdown <= h;
    if (warningRisk && !fault)
      reasons.push(
        `Unpriced non-fault tank-warning risk at ${f.id}; economic comparison withheld`,
      );
    if (
      (!fault && warningRisk) ||
      (fault &&
        get(f.pump.id, "status") === 2 &&
        pred?.hoursToShutdown !== null &&
        pred?.hoursToShutdown !== undefined &&
        ["rising", "at_shutdown"].includes(pred.state) &&
        pred.hoursToShutdown <= h &&
        (pred.state === "at_shutdown" ||
          pred.hoursToShutdown <= pred.repairRemainingHours))
    )
      atRiskFacilities++;
  }
  if (quality !== "ready") reasons.push(`Source quality is ${quality}`);
  if (report.systems.some((s) => s.status === "unavailable"))
    reasons.push("At least one system has an unavailable cost plan");
  if (
    report.systems.some(
      (s) => s.status !== "unavailable" && s.result.search.truncated,
    )
  )
    reasons.push(
      "Bounded cost search was truncated; automatic economic shutdown withheld",
    );
  const plans = new Map<string, FacilityPlan>(),
    baselines = new Map<string, FacilityPlan>();
  for (const sys of report.systems)
    if (sys.status !== "unavailable") {
      for (const plan of sys.result.plans) plans.set(plan.facilityId, plan);
      for (const c of sys.result.comparisons)
        baselines.set(c.facilityId, c.baseline);
    }
  const strategyCost = (selection: Map<string, FacilityPlan>) => {
    let lostRevenue = 0,
      actionCost = 0;
    const intervals: Interval[] = [];
    for (const f of facilities) {
      const plan = selection.get(f.id),
        prediction = a.predictions.find((x) => x.facilityId === f.id),
        repair = prediction?.repairRemainingHours ?? h;
      if (plan) actionCost += plan.truckCost;
      for (const w of f.wells) {
        if (get(w.id, "status") !== 1) continue;
        const cut =
            plan?.wellCuts.find((c) => c.wellId === w.id)?.startAfterHours ?? h,
          trip = plan?.automaticShutdownAfterHours ?? h;
        const firstEnd = Math.min(h, cut, trip),
          on: Interval[] = [];
        if (firstEnd > 0) on.push([0, firstEnd]);
        if (plan && repair < h && repair > firstEnd) on.push([repair, h]);
        intervals.push(...on);
        const hours = on.reduce((sum, [start, end]) => sum + end - start, 0);
        lostRevenue +=
          ((w.oil_bpd * d.ops.prices.oil_per_bbl +
            w.gas_mcfd * d.ops.prices.gas_per_mcf) /
            24) *
          (h - hours);
      }
    }
    const operatingHours = unionHours(intervals),
      operatingCost = operatingHours * p.avoidableOperatingCostPerHour;
    return {
      lostRevenue,
      actionCost,
      operatingHours,
      operatingCost,
      totalCost: lostRevenue + actionCost + operatingCost,
    };
  };
  const selective = strategyCost(plans),
    acceptShutdowns = strategyCost(baselines),
    fullShutdown = {
      lostRevenue: revenuePerHour * h,
      actionCost: p.shutdownCost + p.restartCost,
      operatingHours: 0,
      operatingCost: 0,
      totalCost: revenuePerHour * h + p.shutdownCost + p.restartCost,
    };
  const allAtRisk =
    quality === "ready" &&
    reasons.every((r) => !r.startsWith("Missing")) &&
    producingFacilities > 0 &&
    atRiskFacilities === producingFacilities;
  const economic =
    quality === "ready" &&
    !reasons.length &&
    producingWells > 0 &&
    fullShutdown.totalCost + p.minimumSaving <
      Math.min(selective.totalCost, acceptShutdowns.totalCost);
  const trigger = p.enabled && (allAtRisk || economic),
    triggerReason = trigger
      ? allAtRisk
        ? "all_producing_facilities_at_risk"
        : "lowest_modeled_cost"
      : null;
  return {
    state: reasons.length ? "comparison_incomplete" : "ready",
    trigger,
    triggerReason,
    allAtRisk,
    producingWells,
    producingFacilities,
    atRiskFacilities,
    revenuePerHour,
    horizonHours: h,
    selective,
    acceptShutdowns,
    fullShutdown,
    savingsVsSelective: selective.totalCost - fullShutdown.totalCost,
    reasons,
    explanation:
      triggerReason === "all_producing_facilities_at_risk"
        ? "Every producing facility has a usable shutdown-threshold forecast within the horizon. Fault forecasts also account for expected repair. This protective simulation policy can trigger even when selective mitigation costs less."
        : triggerReason === "lowest_modeled_cost"
          ? "An immediate full-field stop has the lowest cost among the completed modeled strategies."
          : "No automatic full-field shutdown condition is established.",
    assumptions:
      "All strategies use the same horizon. Costs are incremental to currently observed producing wells. Repairs restore those wells only in the cost simulation. Full stop stays latched for the horizon. Avoidable field operating cost and shutdown/restart costs are explicit demo assumptions (default zero). Search is bounded, not a global optimum guarantee.",
    simulated: true,
  };
}
