export type LevelSample = { atMs: number; levelPct: number };
export function predictLevel(
  samples: LevelSample[],
  nowMs: number,
  threshold: number,
) {
  const recent = samples.filter(
    (s) => nowMs - s.atMs <= 30_000 && nowMs >= s.atMs,
  );
  const last = recent.at(-1);
  if (!last || nowMs - last.atMs > 10_000)
    return {
      state: "stale",
      samples: recent.length,
      smoothedPct: null,
      ratePctPerSecond: null,
      secondsToThreshold: null,
    };
  let ema = recent[0].levelPct;
  const smoothed = recent.map((s) => {
    ema = 0.35 * s.levelPct + 0.65 * ema;
    return { ...s, levelPct: ema };
  });
  if (last.levelPct >= threshold)
    return {
      state: "threshold_reached",
      samples: recent.length,
      smoothedPct: ema,
      ratePctPerSecond: null,
      secondsToThreshold: 0,
    };
  if (
    recent.length < 5 ||
    last.atMs - recent[0].atMs < 4000 ||
    recent.some((s, i) => i > 0 && s.atMs - recent[i - 1].atMs > 5000)
  )
    return {
      state: "insufficient_data",
      samples: recent.length,
      smoothedPct: ema,
      ratePctPerSecond: null,
      secondsToThreshold: null,
    };
  const times = smoothed.map((s) => (s.atMs - smoothed[0].atMs) / 1000),
    meanT = times.reduce((a, b) => a + b, 0) / times.length,
    meanY = smoothed.reduce((a, b) => a + b.levelPct, 0) / times.length;
  const rate =
    smoothed.reduce(
      (s, r, i) => s + (times[i] - meanT) * (r.levelPct - meanY),
      0,
    ) / times.reduce((s, t) => s + (t - meanT) ** 2, 0);
  return {
    state: rate > 0.01 ? "rising" : "not_rising",
    samples: recent.length,
    smoothedPct: ema,
    ratePctPerSecond: rate,
    secondsToThreshold:
      rate > 0.01 ? Math.max(0, (threshold - last.levelPct) / rate) : null,
  };
}
export const DEMO_NOTICE =
  "SIMULATED ADVISORY ONLY. No equipment controls, dispatches, or physical shutdown commands.";
export type CompressorConfig = {
  horizonHours: number;
  standbyAvailable: boolean;
  standbyDelayHours: number;
  standbyStartupCost: number;
  standbyHourlyCost: number;
  maintenanceAvailable: boolean;
  maintenanceHours: number;
  maintenanceCost: number;
  gasValuePerMcf: number;
};
export const DEFAULT_COMPRESSOR: CompressorConfig = {
  horizonHours: 6,
  standbyAvailable: true,
  standbyDelayHours: 0.25,
  standbyStartupCost: 500,
  standbyHourlyCost: 150,
  maintenanceAvailable: true,
  maintenanceHours: 2,
  maintenanceCost: 1500,
  gasValuePerMcf: 3,
};
export const SIX_WELLS = [1000, 1400, 1800, 1200, 1600, 2000]; // fictional Mcf/day, explicitly separate from challenge wells
export function compressorComparison(c: CompressorConfig, tripped: boolean) {
  if (
    !c ||
    Object.keys(DEFAULT_COMPRESSOR).some(
      (k) =>
        typeof c[k as keyof CompressorConfig] !==
        typeof DEFAULT_COMPRESSOR[k as keyof CompressorConfig],
    )
  )
    throw new Error("Missing or invalid compressor settings");
  for (const [k, v] of Object.entries(c))
    if (typeof v === "number" && (!Number.isFinite(v) || v < 0))
      throw new Error(`Invalid ${k}`);
  if (c.horizonHours <= 0 || c.horizonHours > 168)
    throw new Error("Horizon must be >0 and <=168 hours");
  const rate = SIX_WELLS.reduce((a, b) => a + b, 0),
    hourly = (rate / 24) * c.gasValuePerMcf;
  return [
    {
      action: "curtailment",
      feasible: true,
      reason: "All six fictional wells deferred for the horizon.",
      actionCost: 0,
      lostRevenue: tripped ? hourly * c.horizonHours : 0,
    },
    {
      action: "standby_compressor",
      feasible: c.standbyAvailable && c.standbyDelayHours < c.horizonHours,
      reason:
        "Assumes full replacement capacity after configured startup delay.",
      actionCost: tripped
        ? c.standbyStartupCost +
          c.standbyHourlyCost *
            Math.max(0, c.horizonHours - c.standbyDelayHours)
        : 0,
      lostRevenue: tripped
        ? hourly * Math.min(c.horizonHours, c.standbyDelayHours)
        : 0,
    },
    {
      action: "maintenance",
      feasible: c.maintenanceAvailable && c.maintenanceHours < c.horizonHours,
      reason:
        "Assumes successful full-capacity repair after configured duration.",
      actionCost: tripped ? c.maintenanceCost : 0,
      lostRevenue: tripped
        ? hourly * Math.min(c.horizonHours, c.maintenanceHours)
        : 0,
    },
  ].map((r) => ({
    ...r,
    totalCost: r.actionCost + r.lostRevenue,
    horizonHours: c.horizonHours,
    advisoryOnly: true,
  }));
}
