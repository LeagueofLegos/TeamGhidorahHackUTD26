import type { Dataset, Facility } from "./dataset.js";

export type Category = "pump_failure" | "pump_degradation" | "pipeline_leak";
export type DetectedEvent = {
  id: string;
  systemId: string;
  facilityId: string;
  assetId: string;
  category: Category;
  status: "ongoing" | "resolved";
  onsetTs: number;
  detectedAtTs: number;
  endTs: number | null;
  evidence: string[];
};
export type FailurePrediction = {
  facilityId: string;
  state: "insufficient_data" | "stale" | "at_shutdown" | "not_filling" | "rising";
  levelPct: number | null;
  sampleCount: number;
  netInflowBblPerHour: number | null;
  hoursToShutdown: number | null;
  repairRemainingHours: number;
};

export const DETECTION_SETTINGS = {
  confirmSamples: 3,
  smoothingSamples: 5,
  degradationRatio: 0.98,
  recoveredPumpRatio: 0.99,
  leakFraction: 0.025,
  recoveredLeakFraction: 0.01,
  minimumFlowBpd: 10,
  predictionSamples: 3,
  predictionWindowSeconds: 1800,
  maxGapSeconds: 600,
  staleAfterSeconds: 600
};

type Signal = {
  active?: DetectedEvent;
  suspectTs?: number;
  bad: number;
  good: number;
};
type FlowSample = { ts: number; netBpd: number };
type Track = {
  facility: Facility;
  systemId: string;
  failure: Signal;
  wear: Signal;
  leak: Signal;
  ratios: number[];
  gaps: number[];
  flows: FlowSample[];
};
const freshSignal = (): Signal => ({ bad: 0, good: 0 });
const seriesKey = (asset: string, metric: string) => JSON.stringify([asset, metric]);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
const revenuePerHour = (d: Dataset, f: Facility) => f.wells.reduce(
  (total, well) => total + well.oil_bpd * d.ops.prices.oil_per_bbl +
    well.gas_mcfd * d.ops.prices.gas_per_mcf, 0
) / 24;

export function analyzeDataset(dataset: Dataset, asOfTs = dataset.nowTs) {
  if (!Number.isSafeInteger(asOfTs) || asOfTs < dataset.firstTs) {
    throw new Error("Analysis time must be an integer timestamp at/after the first reading.");
  }
  const c = DETECTION_SETTINGS;
  const events: DetectedEvent[] = [];
  const tracks: Track[] = dataset.network.systems.flatMap(system =>
    system.facilities.map(facility => ({
      facility, systemId: system.id,
      failure: freshSignal(), wear: freshSignal(), leak: freshSignal(),
      ratios: [], gaps: [], flows: []
    }))
  );
  let lastTs = -Infinity;
  let frame = new Map<string, number>();

  const open = (track: Track, signal: Signal, category: Category,
    onsetTs: number, detectedAtTs: number, evidence: string) => {
    const event: DetectedEvent = {
      id: `${track.facility.id}/${category}/${onsetTs}`,
      systemId: track.systemId,
      facilityId: track.facility.id,
      assetId: category === "pipeline_leak" ? track.facility.pipeline.id : track.facility.pump.id,
      category, status: "ongoing", onsetTs, detectedAtTs,
      endTs: null, evidence: [evidence]
    };
    signal.active = event;
    signal.bad = 0;
    signal.good = 0;
    signal.suspectTs = undefined;
    events.push(event);
  };
  const close = (signal: Signal, ts: number, reason: string) => {
    if (signal.active) {
      signal.active.status = "resolved";
      signal.active.endTs = ts;
      signal.active.evidence.push(reason);
    }
    signal.active = undefined;
    signal.suspectTs = undefined;
    signal.bad = 0;
    signal.good = 0;
  };
  const inspect = (track: Track, signal: Signal, category: Category,
    ts: number, bad: boolean, recovered: boolean, evidence: string) => {
    if (!signal.active) {
      if (!bad) { signal.bad = 0; signal.suspectTs = undefined; return; }
      signal.suspectTs ??= ts;
      if (++signal.bad >= c.confirmSamples) {
        open(track, signal, category, signal.suspectTs, ts, evidence);
      }
    } else {
      signal.good = recovered ? signal.good + 1 : 0;
      if (signal.good >= c.confirmSamples) {
        close(signal, ts, "Recovered across consecutive running measurements.");
      }
    }
  };

  // Readings are ordered by loadDataset. Process a complete timestamp together.
  let cursor = 0;
  while (cursor < dataset.readings.length && dataset.readings[cursor].ts_unix <= asOfTs) {
    const ts = dataset.readings[cursor].ts_unix;
    const gap = ts - lastTs > c.maxGapSeconds;
    frame = new Map();
    while (cursor < dataset.readings.length && dataset.readings[cursor].ts_unix === ts) {
      const row = dataset.readings[cursor++];
      frame.set(seriesKey(row.asset_id, row.metric), row.value);
    }
    lastTs = ts;
    const get = (id: string, metric: string) => frame.get(seriesKey(id, metric));

    for (const track of tracks) {
      const f = track.facility;
      const status = get(f.pump.id, "status");
      const flow = get(f.pump.id, "flow_bpd");
      const received = get(f.pipeline.id, "receive_flow_bpd");
      const inflow = get(f.id, "inflow_bpd");

      if (gap) {
        track.ratios = []; track.gaps = []; track.flows = [];
        for (const signal of [track.wear, track.leak]) {
          signal.bad = 0; signal.good = 0; signal.suspectTs = undefined;
        }
      }

      if (status === 2) {
        if (!track.failure.active) {
          open(track, track.failure, "pump_failure", ts, ts,
            "Pump reports fault status 2. Flow and tank measurements support the countdown separately.");
          close(track.wear, ts, "Degradation episode ended as the pump entered fault.");
          track.ratios = []; track.gaps = []; track.flows = [];
        }
        if (flow !== undefined && inflow !== undefined) {
          const previousFlow = track.flows.at(-1);
          if (previousFlow && ts - previousFlow.ts > c.maxGapSeconds) {
            track.flows = [];
          }
          track.flows.push({ ts, netBpd: inflow - flow });
          track.flows = track.flows.filter(s => ts - s.ts <= c.predictionWindowSeconds);
        }
      } else if (status !== undefined) {
        if (track.failure.active) close(track.failure, ts, "Pump no longer reports fault status.");
        track.flows = [];
      }

      // Stopped pumps cannot establish recovery of a leak or loss of running capacity.
      if (status !== 1 || flow === undefined || flow < c.minimumFlowBpd) {
        for (const signal of [track.wear, track.leak]) {
          signal.bad = 0; signal.good = 0; signal.suspectTs = undefined;
        }
        continue;
      }

      track.ratios.push(flow / f.pump.max_flow_bpd);
      track.ratios = track.ratios.slice(-c.smoothingSamples);
      if (track.ratios.length >= c.confirmSamples) {
        const ratio = median(track.ratios);
        inspect(track, track.wear, "pump_degradation", ts,
          ratio < c.degradationRatio, ratio >= c.recoveredPumpRatio,
          `Median running flow is ${(ratio * 100).toFixed(1)}% of configured healthy flow; persistent reduction across running measurements.`);
      }
      if (received !== undefined) {
        track.gaps.push((flow - received) / flow);
        track.gaps = track.gaps.slice(-c.smoothingSamples);
        if (track.gaps.length >= c.confirmSamples) {
          const fraction = median(track.gaps);
          inspect(track, track.leak, "pipeline_leak", ts,
            fraction > c.leakFraction, fraction <= c.recoveredLeakFraction,
            `Median received-flow shortfall is ${(fraction * 100).toFixed(1)}%; persistent imbalance while pumping.`);
        }
      } else {
        track.leak.bad = 0; track.leak.good = 0; track.leak.suspectTs = undefined;
      }
    }
  }

  const get = (id: string, metric: string) => frame.get(seriesKey(id, metric)) ?? null;
  const predictions: FailurePrediction[] = tracks.filter(t => t.failure.active).map(track => {
    const f = track.facility;
    const event = track.failure.active!;
    const level = get(f.tank.id, "level_pct");
    const samples = track.flows.filter(s => asOfTs - s.ts <= c.predictionWindowSeconds);
    const result: FailurePrediction = {
      facilityId: f.id, state: "insufficient_data", levelPct: level,
      sampleCount: samples.length, netInflowBblPerHour: null,
      hoursToShutdown: null,
      repairRemainingHours: Math.max(0,
        dataset.ops.expected_repair_hours.pump_failure - (asOfTs - event.onsetTs) / 3600)
    };
    const latestFlow = samples.at(-1);
    if (asOfTs - lastTs > c.staleAfterSeconds ||
        (latestFlow && asOfTs - latestFlow.ts > c.staleAfterSeconds)) {
      result.state = "stale";
    } else if (level !== null && level >= dataset.network.defaults.tank_limits_pct.shutdown) {
      result.state = "at_shutdown"; result.hoursToShutdown = 0;
    } else if (level !== null && get(f.pump.id, "status") === 2 &&
        get(f.id, "inflow_bpd") !== null &&
        get(f.pump.id, "flow_bpd") !== null && samples.length >= c.predictionSamples) {
      const rate = median(samples.map(s => s.netBpd)) / 24;
      result.netInflowBblPerHour = rate;
      if (rate <= 0) {
        result.state = "not_filling";
      } else {
        result.state = "rising";
        const remaining = Math.max(0, f.tank.capacity_bbl *
          (dataset.network.defaults.tank_limits_pct.shutdown - level) / 100);
        result.hoursToShutdown = Math.max(0, remaining / rate - (asOfTs - lastTs) / 3600);
      }
    }
    return result;
  });

  const predictionByFacility = new Map(predictions.map(p => [p.facilityId, p]));
  const facilityById = new Map(tracks.map(t => [t.facility.id, t.facility]));
  const alerts = events.filter(e => e.status === "ongoing").sort((a, b) => {
    const aFailure = a.category === "pump_failure", bFailure = b.category === "pump_failure";
    if (aFailure !== bFailure) return aFailure ? -1 : 1;
    if (aFailure) {
      const aHours = predictionByFacility.get(a.facilityId)?.hoursToShutdown ?? Infinity;
      const bHours = predictionByFacility.get(b.facilityId)?.hoursToShutdown ?? Infinity;
      if (aHours !== bHours) return aHours - bHours;
      const difference = revenuePerHour(dataset, facilityById.get(b.facilityId)!) -
        revenuePerHour(dataset, facilityById.get(a.facilityId)!);
      if (difference) return difference;
    }
    return a.id.localeCompare(b.id);
  });
  return { nowTs: asOfTs, events, alerts, predictions };
}
