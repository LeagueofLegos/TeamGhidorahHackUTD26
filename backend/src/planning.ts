// Pure advisory simulation. All times below are hours after the planning instant.
// The failed pump is modeled as stopped; water rates remain at configured baselines.
export type PlanningWell = {
  id: string;
  waterBpd: number;
  revenuePerHour: number;
  producing: boolean;
};
export type PlanningInput = {
  systemId: string;
  facilityId: string;
  capacityBbl: number;
  levelPct: number;
  shutdownPct: number;
  repairHours: number;
  responseHours: number;
  cycleHours: number;
  truckCapacityBbl: number;
  costPerTrip: number;
  alreadyShutIn: boolean;
  wells: PlanningWell[];
};
export type WellCut = { wellId: string; startAfterHours: number };
export type TruckJob = { truckId: string; dispatchAfterHours: number; trips: number };
export type TruckReservation = TruckJob & {
  arrivalsAfterHours: number[];
  freeAfterHours: number;
};
export type TimelinePoint = { afterHours: number; volumeBbl: number; event: string };
export type FacilityPlan = {
  facilityId: string;
  kind: "none" | "accept_shutdown" | "well_shut_in" | "trucking" | "mixed";
  horizonHours: number;
  wellCuts: WellCut[];
  trucks: TruckReservation[];
  truckCost: number;
  lostRevenue: number;
  totalCost: number;
  automaticShutdownAfterHours: number | null;
  timeline: TimelinePoint[];
  explanation: string;
};
export type PlanningOptions = {
  safetyMarginBbl?: number;
  maxSearchStates?: number;
  maxLinearVertices?: number;
  maxTripsPerTruck?: number;
  maxControlWells?: number;
};
type Budget = { states: number; vertices: number; truncated: boolean };
type Visit = { at: number; load: number };
type Constraint = { a: number[]; b: number };
const EPS = 1e-7;
const TIME_EPS = 1e-9;
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const initialVolume = (input: PlanningInput) => input.capacityBbl * input.levelPct / 100;
const limitVolume = (input: PlanningInput) => input.capacityBbl * input.shutdownPct / 100;
const waterRate = (well: PlanningWell) => well.producing ? well.waterBpd / 24 : 0;
const totalRate = (input: PlanningInput) => input.wells.reduce((sum, w) => sum + waterRate(w), 0);

function validateInput(input: PlanningInput) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid planning field ${name}`);
    }
  }
  if (!input.systemId || !input.facilityId || input.capacityBbl <= 0 ||
      input.levelPct > 100 || input.shutdownPct <= 0 || input.shutdownPct > 100 ||
      input.repairHours <= 0 || input.repairHours > 168 || input.cycleHours <= 0 ||
      input.truckCapacityBbl <= 0 || !input.wells.length) {
    throw new Error("Invalid planning limits, duration, or wells.");
  }
  const ids = new Set<string>();
  for (const well of input.wells) {
    if (!well.id || ids.has(well.id) || typeof well.producing !== "boolean" ||
        !Number.isFinite(well.waterBpd) || well.waterBpd < 0 ||
        !Number.isFinite(well.revenuePerHour) || well.revenuePerHour < 0) {
      throw new Error("Invalid or duplicate planning well.");
    }
    ids.add(well.id);
  }
}

function reservations(input: PlanningInput, jobs: TruckJob[]): TruckReservation[] {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (!job.truckId || ids.has(job.truckId) || !Number.isInteger(job.trips) || job.trips < 1 ||
        job.trips > 1000 || !Number.isFinite(job.dispatchAfterHours) || job.dispatchAfterHours < 0) {
      throw new Error("Invalid or duplicate truck job.");
    }
    ids.add(job.truckId);
  }
  if (jobs.some(job => Math.abs(job.dispatchAfterHours - jobs[0].dispatchAfterHours) > TIME_EPS)) {
    throw new Error("Trucks in a facility plan must be called together.");
  }
  return jobs.map(job => {
    const last = job.dispatchAfterHours + input.responseHours + (job.trips - 1) * input.cycleHours;
    if (last >= input.repairHours - TIME_EPS) throw new Error("A truck arrives at/after repair completion.");
    return {
      ...job,
      arrivalsAfterHours: Array.from({ length: job.trips }, (_, i) =>
        job.dispatchAfterHours + input.responseHours + i * input.cycleHours),
      freeAfterHours: last + input.cycleHours
    };
  });
}

function visitsFor(input: PlanningInput, trucks: TruckReservation[]): Visit[] {
  const visits = new Map<number, number>();
  for (const truck of trucks) for (const at of truck.arrivalsAfterHours) {
    visits.set(at, (visits.get(at) ?? 0) + input.truckCapacityBbl);
  }
  return [...visits].map(([at, load]) => ({ at, load })).sort((a, b) => a.at - b.at);
}

// Independent continuous-time feasibility check, including the instant BEFORE unloading.
export function simulatePreventivePlan(input: PlanningInput, cuts: WellCut[], jobs: TruckJob[]) {
  validateInput(input);
  const fail = (reason: string) => ({ feasible: false, reason, timeline: [] as TimelinePoint[] });
  if (input.alreadyShutIn || initialVolume(input) >= limitVolume(input)) {
    return fail("The facility is already shut in; this model cannot restart it before repair.");
  }
  const wells = new Map(input.wells.map(well => [well.id, well]));
  const cutIds = new Set<string>();
  for (const cut of cuts) {
    if (!wells.get(cut.wellId)?.producing || cutIds.has(cut.wellId) ||
        !Number.isFinite(cut.startAfterHours) || cut.startAfterHours < 0 || cut.startAfterHours > input.repairHours) {
      return fail("Unknown, duplicate, inactive, or mistimed well shut-in.");
    }
    cutIds.add(cut.wellId);
  }
  let trucks: TruckReservation[];
  try { trucks = reservations(input, jobs); } catch (error) { return fail(String(error)); }
  const visits = visitsFor(input, trucks);
  const points = [...new Set([0, input.repairHours, ...visits.map(v => v.at), ...cuts.map(c => c.startAfterHours)])]
    .sort((a, b) => a - b);
  let volume = initialVolume(input), rate = totalRate(input), previous = 0;
  const timeline: TimelinePoint[] = [{ afterHours: 0, volumeBbl: volume, event: "observed_start" }];
  for (const at of points) {
    volume += rate * (at - previous);
    if (volume >= limitVolume(input) - EPS) return fail("The tank reaches shutdown before the next action or repair.");
    timeline.push({ afterHours: at, volumeBbl: volume, event: "before_actions" });
    const visit = visits.find(v => v.at === at);
    if (visit) {
      if (volume < visit.load - EPS) return fail("A full truck load exceeds the water in the tank.");
      volume = Math.max(0, volume - visit.load);
      timeline.push({ afterHours: at, volumeBbl: volume, event: "truck_unload" });
    }
    for (const cut of cuts.filter(c => c.startAfterHours === at)) {
      rate -= waterRate(wells.get(cut.wellId)!);
      timeline.push({ afterHours: at, volumeBbl: volume, event: `shut_in:${cut.wellId}` });
    }
    rate = Math.max(0, rate);
    previous = at;
  }
  return { feasible: true, reason: "Tank remains below shutdown until repair.", timeline };
}

export function evaluatePreventivePlan(input: PlanningInput, cuts: WellCut[], jobs: TruckJob[]): FacilityPlan | null {
  const simulation = simulatePreventivePlan(input, cuts, jobs);
  if (!simulation.feasible) return null;
  const trucks = reservations(input, jobs);
  const meaningfulCuts = cuts.filter(c => input.repairHours - c.startAfterHours > TIME_EPS);
  const starts = new Map(meaningfulCuts.map(cut => [cut.wellId, cut.startAfterHours]));
  const lostRevenue = input.wells.reduce((sum, well) => sum + well.revenuePerHour *
    (well.producing ? input.repairHours - (starts.get(well.id) ?? input.repairHours) : input.repairHours), 0);
  const truckCost = trucks.reduce((sum, truck) => sum + truck.trips * input.costPerTrip, 0);
  return {
    facilityId: input.facilityId,
    kind: trucks.length ? (meaningfulCuts.length ? "mixed" : "trucking") : (meaningfulCuts.length ? "well_shut_in" : "none"),
    horizonHours: input.repairHours, wellCuts: meaningfulCuts, trucks,
    truckCost, lostRevenue, totalCost: truckCost + lostRevenue,
    automaticShutdownAfterHours: null, timeline: simulation.timeline,
    explanation: simulation.reason
  };
}

export function acceptShutdown(input: PlanningInput): FacilityPlan {
  validateInput(input);
  const rate = totalRate(input), volume = initialVolume(input), limit = limitVolume(input);
  const already = input.alreadyShutIn || volume >= limit || input.wells.every(well => !well.producing);
  const at = already ? 0 : rate > 0 ? Math.max(0, (limit - volume) / rate) : Infinity;
  const trips = at <= input.repairHours;
  const lostRevenue = input.wells.reduce((sum, well) => sum + well.revenuePerHour *
    (already || !well.producing ? input.repairHours : Math.max(0, input.repairHours - at)), 0);
  return {
    facilityId: input.facilityId, kind: already || trips ? "accept_shutdown" : "none",
    horizonHours: input.repairHours, wellCuts: [], trucks: [], truckCost: 0,
    lostRevenue, totalCost: lostRevenue, automaticShutdownAfterHours: already || trips ? at : null,
    timeline: [
      { afterHours: 0, volumeBbl: volume, event: "observed_start" },
      { afterHours: Math.min(at, input.repairHours), volumeBbl: already ? volume : Math.min(limit, volume + rate * Math.min(at, input.repairHours)), event: trips || already ? "automatic_shutdown" : "repair" },
      { afterHours: input.repairHours, volumeBbl: already ? volume : Math.min(limit, volume + rate * input.repairHours), event: "repair" }
    ],
    explanation: already ? "Recorded shutdown remains in effect until repair; no restart is assumed." :
      trips ? "Accept the automatic protective shut-in and its lost production." : "Repair is expected before the tank reaches shutdown."
  };
}

function noTruckPlan(input: PlanningInput, margin: number): FacilityPlan {
  const baseline = acceptShutdown(input);
  if (baseline.kind === "none" || input.alreadyShutIn || initialVolume(input) >= limitVolume(input)) return baseline;
  // One end-volume constraint: continuous fractional-knapsack is exact for no trucking.
  let avoid = Math.max(0, initialVolume(input) + totalRate(input) * input.repairHours - (limitVolume(input) - margin));
  const cuts: WellCut[] = [];
  const candidates = input.wells.filter(well => waterRate(well) > 0).sort((a, b) =>
    a.revenuePerHour / waterRate(a) - b.revenuePerHour / waterRate(b) || a.id.localeCompare(b.id));
  for (const well of candidates) {
    const duration = Math.min(input.repairHours, avoid / waterRate(well));
    if (duration > TIME_EPS) cuts.push({ wellId: well.id, startAfterHours: Math.max(0, input.repairHours - duration) });
    avoid = Math.max(0, avoid - duration * waterRate(well));
  }
  const plan = avoid <= EPS ? evaluatePreventivePlan(input, cuts, []) : null;
  return plan && plan.totalCost < baseline.totalCost ? plan : baseline;
}

function solveEquations(rows: Constraint[]): number[] | null {
  const n = rows.length;
  const matrix = rows.map(row => [...row.a, row.b]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let i = column + 1; i < n; i++) if (Math.abs(matrix[i][column]) > Math.abs(matrix[pivot][column])) pivot = i;
    if (Math.abs(matrix[pivot][column]) < 1e-10) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const scale = matrix[column][column];
    for (let j = column; j <= n; j++) matrix[column][j] /= scale;
    for (let i = 0; i < n; i++) if (i !== column) {
      const factor = matrix[i][column];
      for (let j = column; j <= n; j++) matrix[i][j] -= factor * matrix[column][j];
    }
  }
  const result = matrix.map(row => row[n]);
  return result.every(Number.isFinite) ? result : null;
}

// For fixed truck visits, enumerate well shut-in intervals and solve each small LP.
// Duration is the variable; a well stays off from its chosen start until repair.
function optimizeCuts(input: PlanningInput, jobs: TruckJob[], margin: number,
  budget: Budget, maxVertices: number, maxControlWells: number): FacilityPlan | null {
  const uncontrolled = evaluatePreventivePlan(input, [], jobs);
  if (uncontrolled) return uncontrolled;
  const wells = input.wells.filter(well => waterRate(well) > 0);
  if (!wells.length) return null;
  if (wells.length > maxControlWells) { budget.truncated = true; return null; }
  const visits = visitsFor(input, reservations(input, jobs));
  const edges = [...new Set([0, ...visits.map(v => v.at), input.repairHours])].sort((a, b) => a - b);
  const intervals = new Array<number>(wells.length).fill(0);
  let best: FacilityPlan | null = null;
  const evaluateIntervals = () => {
    const constraints: Constraint[] = [];
    for (let i = 0; i < wells.length; i++) {
      const upper = new Array<number>(wells.length).fill(0); upper[i] = 1;
      const lower = new Array<number>(wells.length).fill(0); lower[i] = -1;
      constraints.push({ a: upper, b: input.repairHours - edges[intervals[i]] });
      constraints.push({ a: lower, b: -(input.repairHours - edges[intervals[i] + 1]) });
    }
    let removed = 0;
    for (const point of [...visits, { at: input.repairHours, load: 0 }]) {
      const a = wells.map((well, i) => edges[intervals[i] + 1] <= point.at ? -waterRate(well) : 0);
      const constant = initialVolume(input) + totalRate(input) * point.at - removed +
        a.reduce((sum, coefficient) => sum + coefficient * (point.at - input.repairHours), 0);
      constraints.push({ a, b: limitVolume(input) - margin - constant });
      if (point.load > 0) constraints.push({ a: a.map(x => -x), b: constant - point.load });
      removed += point.load;
    }
    const selected: Constraint[] = [];
    const vertices = (from: number) => {
      if (budget.vertices >= maxVertices) { budget.truncated = true; return; }
      if (selected.length === wells.length) {
        budget.vertices++;
        const durations = solveEquations(selected);
        if (!durations || constraints.some(row => dot(row.a, durations) > row.b + EPS)) return;
        const cuts = wells.map((well, i) => ({ wellId: well.id,
          startAfterHours: Math.min(input.repairHours, Math.max(0, input.repairHours - durations[i])) }));
        const plan = evaluatePreventivePlan(input, cuts, jobs);
        if (plan && (!best || plan.totalCost < best.totalCost - EPS)) best = plan;
        return;
      }
      for (let i = from; i <= constraints.length - (wells.length - selected.length); i++) {
        if (budget.vertices >= maxVertices) { budget.truncated = true; return; }
        selected.push(constraints[i]); vertices(i + 1); selected.pop();
      }
    };
    vertices(0);
  };
  const chooseIntervals = (i: number) => {
    if (budget.vertices >= maxVertices) { budget.truncated = true; return; }
    if (i === wells.length) { evaluateIntervals(); return; }
    for (let interval = 0; interval + 1 < edges.length; interval++) {
      if (budget.vertices >= maxVertices) { budget.truncated = true; return; }
      intervals[i] = interval; chooseIntervals(i + 1);
    }
  };
  chooseIntervals(0);
  return best;
}

export function validateFleet(plans: FacilityPlan[], truckIds: string[]): boolean {
  const allowed = new Set(truckIds);
  const schedules = new Map<string, { start: number; end: number }[]>();
  for (const plan of plans) for (const job of plan.trucks) {
    if (!allowed.has(job.truckId)) return false;
    const list = schedules.get(job.truckId) ?? [];
    list.push({ start: job.dispatchAfterHours, end: job.freeAfterHours });
    schedules.set(job.truckId, list);
  }
  for (const list of schedules.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].end - TIME_EPS) return false;
  }
  return true;
}

export function optimizeSystem(systemId: string, inputs: PlanningInput[], fleetSize: number,
  options: PlanningOptions = {}) {
  if (!systemId || !Number.isInteger(fleetSize) || fleetSize < 0 || fleetSize > 16) throw new Error("Invalid system/fleet size.");
  const ids = new Set<string>();
  for (const input of inputs) {
    validateInput(input);
    if (input.systemId !== systemId || ids.has(input.facilityId)) throw new Error("Mismatched system or duplicate facility.");
    ids.add(input.facilityId);
  }
  const margin = options.safetyMarginBbl ?? 0.01;
  const maxStates = options.maxSearchStates ?? 10000;
  const maxVertices = options.maxLinearVertices ?? 1000000;
  const maxTrips = options.maxTripsPerTruck ?? 6;
  const maxWells = options.maxControlWells ?? 4;
  if (!Number.isFinite(margin) || margin <= EPS ||
      [maxStates, maxVertices, maxTrips, maxWells].some(n => !Number.isInteger(n) || n < 1)) {
    throw new Error("Invalid search limits or safety margin.");
  }
  const budget: Budget = { states: 0, vertices: 0, truncated: false };
  const truckIds = Array.from({ length: fleetSize }, (_, i) => `${systemId}/TRUCK-${i + 1}`);
  const baselines = inputs.map(acceptShutdown);
  const noTrucks = inputs.map(input => noTruckPlan(input, margin));
  let best = noTrucks;
  let bestCost = best.reduce((sum, plan) => sum + plan.totalCost, 0);
  const memo = new Map<string, number>();
  const cache = new Map<string, FacilityPlan | null>();
  const localAlternatives = inputs.map((_, i) => new Map<string, FacilityPlan>([
    [baselines[i].kind, baselines[i]], [noTrucks[i].kind, noTrucks[i]]
  ]));

  const candidates = (index: number, available: number[]) => {
    const input = inputs[index];
    const plans = [noTrucks[index]];
    if (input.alreadyShutIn || initialVolume(input) >= limitVolume(input) || totalRate(input) <= 0) return plans;
    const selected: number[] = [];
    const counts: number[] = [];
    const make = () => {
      let dispatch = Math.max(0, ...selected.map(i => available[i]));
      const pattern = new Map<number, number>();
      counts.forEach(trips => { for (let trip = 0; trip < trips; trip++) {
        const relative = input.responseHours + trip * input.cycleHours;
        pattern.set(relative, (pattern.get(relative) ?? 0) + input.truckCapacityBbl);
      } });
      let removed = 0;
      for (const [relative, load] of [...pattern].sort((a, b) => a[0] - b[0])) {
        removed += load;
        // Delay only as required for full loads or truck availability.
        dispatch = Math.max(dispatch, (removed - initialVolume(input)) / totalRate(input) - relative);
      }
      if (dispatch + input.responseHours + (Math.max(...counts) - 1) * input.cycleHours >= input.repairHours - TIME_EPS) return;
      const cacheKey = JSON.stringify([index, dispatch, counts]);
      let template = cache.get(cacheKey);
      if (template === undefined) {
        const jobs = counts.map((trips, i) => ({ truckId: `template-${i}`, dispatchAfterHours: dispatch, trips }));
        template = optimizeCuts(input, jobs, margin, budget, maxVertices, maxWells);
        cache.set(cacheKey, template);
      }
      if (!template) return;
      const plan = { ...template, trucks: template.trucks.map((job, i) => ({ ...job, truckId: truckIds[selected[i]] })) };
      plans.push(plan);
      if (available.every(value => value === 0)) {
        const previous = localAlternatives[index].get(plan.kind);
        if (!previous || plan.totalCost < previous.totalCost) localAlternatives[index].set(plan.kind, plan);
      }
    };
    const tripPatterns = (position: number, minimum: number, maximum: number) => {
      if (position === selected.length) { make(); return; }
      for (let count = minimum; count <= maximum; count++) {
        if (budget.vertices >= maxVertices) { budget.truncated = true; return; }
        counts[position] = count; tripPatterns(position + 1, count, maximum);
      }
    };
    const subsets = (from: number) => {
      if (selected.length) {
        const dispatch = Math.max(0, ...selected.map(i => available[i]));
        const first = dispatch + input.responseHours;
        if (first < input.repairHours - TIME_EPS) {
          const possible = Math.ceil((input.repairHours - TIME_EPS - first) / input.cycleHours);
          if (possible > maxTrips) budget.truncated = true;
          counts.length = selected.length;
          tripPatterns(0, 1, Math.min(maxTrips, possible));
        }
      }
      for (let i = from; i < fleetSize; i++) {
        if (budget.vertices >= maxVertices) { budget.truncated = true; return; }
        selected.push(i); subsets(i + 1); selected.pop();
      }
    };
    subsets(0);
    return plans.sort((a, b) => a.totalCost - b.totalCost);
  };

  const search = (remaining: number[], available: number[], selected: FacilityPlan[], cost: number) => {
    if (budget.states >= maxStates) { budget.truncated = true; return; }
    budget.states++;
    if (cost >= bestCost - EPS) return;
    if (!remaining.length) { best = selected; bestCost = cost; return; }
    const state = JSON.stringify([remaining, [...available].sort((a, b) => a - b)]);
    if ((memo.get(state) ?? Infinity) <= cost + EPS) return;
    memo.set(state, cost);
    for (const index of remaining) {
      for (const plan of candidates(index, available)) {
        if (cost + plan.totalCost >= bestCost - EPS) continue;
        const next = [...available];
        for (const truck of plan.trucks) next[truckIds.indexOf(truck.truckId)] = truck.freeAfterHours;
        search(remaining.filter(i => i !== index), next, [...selected, plan], cost + plan.totalCost);
      }
    }
  };
  search(inputs.map((_, i) => i), truckIds.map(() => 0), [], 0);
  if (!validateFleet(best, truckIds)) throw new Error("Internal error: overlapping truck reservations.");
  const baselineCost = baselines.reduce((sum, plan) => sum + plan.totalCost, 0);
  return {
    systemId, fleetSize, truckIds, plans: best.sort((a, b) => a.facilityId.localeCompare(b.facilityId)),
    comparisons: inputs.map((input, i) => ({ facilityId: input.facilityId, baseline: baselines[i],
      standaloneAlternatives: [...localAlternatives[i].values()] })),
    totalCost: bestCost, baselineCost, savings: baselineCost - bestCost,
    search: { states: budget.states, linearVertices: budget.vertices, truncated: budget.truncated,
      scope: "Best found over enumerated full-load truck jobs, earliest candidate yard dispatches, and continuous well shut-in times. Not an unrestricted global-optimum guarantee." },
    advisoryOnly: true as const
  };
}
