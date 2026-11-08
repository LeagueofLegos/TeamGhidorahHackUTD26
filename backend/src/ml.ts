import type { Facility, Network, Reading } from "./dataset.js";
export const CLASSES = ["normal", "pipeline_leak", "pump_degradation"] as const;
export const FEATURES = [
  "flow_capacity_ratio",
  "received_shortfall_fraction",
  "pump_pressure_ratio",
  "pipeline_pressure_ratio",
] as const;
export const TEMPORAL_FEATURES = [
  ...FEATURES,
  ...FEATURES.map((name) => `median5_${name}`),
];
export type Model = {
  version: 1 | 2;
  kind: "softmax";
  classes: string[];
  features: string[];
  trainedThroughTs: number;
  means: number[];
  scales: number[];
  weights: number[][];
  bias: number[];
  fitThroughTs?: number;
  temperature?: number;
  minScore?: number;
  minMargin?: number;
  maxAbsZ?: number;
};
export type MLContext = {
  lastTs: number | null;
  windows: Record<string, { ts: number; x: number[] }[]>;
};
export const createMLContext = (): MLContext => ({ lastTs: null, windows: {} });
export function features(
  f: Facility,
  disposalPressure: number,
  get: (asset: string, metric: string) => number | undefined,
): number[] | null {
  const flow = get(f.pump.id, "flow_bpd"),
    received = get(f.pipeline.id, "receive_flow_bpd"),
    pressure = get(f.pump.id, "discharge_psi"),
    pipeline = get(f.pipeline.id, "pressure_psi");
  if (
    get(f.pump.id, "status") !== 1 ||
    flow === undefined ||
    flow < 10 ||
    received === undefined ||
    pressure === undefined ||
    pipeline === undefined
  )
    return null;
  const x = [
    flow / f.pump.max_flow_bpd,
    (flow - received) / flow,
    pressure / (disposalPressure + 150),
    pipeline / (disposalPressure + 50),
  ];
  return x.every(Number.isFinite) ? x : null;
}
export function advanceMLContext(
  context: MLContext,
  network: Network,
  rows: Reading[],
) {
  if (!rows.length) return;
  const ts = rows[0].ts_unix;
  if (context.lastTs !== null && ts <= context.lastTs)
    throw new Error("ML frames must increase in time");
  const frame = new Map(
    rows.map((r) => [`${r.asset_id}/${r.metric}`, r.value]),
  );
  for (const sys of network.systems)
    for (const f of sys.facilities) {
      const x = features(f, sys.disposal_site.pressure_psi, (a, m) =>
        frame.get(`${a}/${m}`),
      );
      let window = context.windows[f.id] ?? [];
      if (!x) {
        delete context.windows[f.id];
        continue;
      }
      if (window.at(-1) && ts - window.at(-1)!.ts > 600) window = [];
      context.windows[f.id] = [...window, { ts, x }].slice(-5);
    }
  context.lastTs = ts;
}
export function contextFeatures(
  context: MLContext,
  facilityId: string,
  dimensions = 8,
): number[] | null {
  const window = context.windows[facilityId],
    last = window?.at(-1);
  if (!last || last.ts !== context.lastTs) return null;
  if (dimensions === 4) return [...last.x];
  return [
    ...last.x,
    ...FEATURES.map((_, j) => {
      const sorted = window.map((s) => s.x[j]).sort((a, b) => a - b),
        i = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
    }),
  ];
}
export function validateModel(m: Model) {
  const d = m?.features?.length;
  if (
    !m ||
    ![1, 2].includes(m.version) ||
    m.kind !== "softmax" ||
    JSON.stringify(m.classes) !== JSON.stringify(CLASSES) ||
    ![4, 8].includes(d) ||
    JSON.stringify(m.features) !==
      JSON.stringify(d === 4 ? FEATURES : TEMPORAL_FEATURES) ||
    !Number.isSafeInteger(m.trainedThroughTs) ||
    m.trainedThroughTs < 0 ||
    !Array.isArray(m.means) ||
    !Array.isArray(m.scales) ||
    !Array.isArray(m.weights) ||
    !Array.isArray(m.bias) ||
    m.means.length !== d ||
    m.scales.length !== d ||
    m.weights.length !== 3 ||
    m.bias.length !== 3 ||
    m.weights.some((w) => !Array.isArray(w) || w.length !== d) ||
    [...m.means, ...m.scales, ...m.weights.flat(), ...m.bias].some(
      (v) => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e6,
    ) ||
    m.scales.some((v) => v <= 0) ||
    (m.version === 2 &&
      (!Number.isSafeInteger(m.fitThroughTs) ||
        m.fitThroughTs! > m.trainedThroughTs ||
        !(m.temperature! >= 0.1 && m.temperature! <= 10) ||
        !(m.minScore! >= 0 && m.minScore! <= 1) ||
        !(m.minMargin! >= 0 && m.minMargin! <= 1) ||
        !(m.maxAbsZ! >= 5 && m.maxAbsZ! <= 100)))
  )
    throw new Error("Invalid model artifact");
}
export function scoreModel(m: Model, x: number[]) {
  const z = x.map((v, j) => (v - m.means[j]) / m.scales[j]);
  const logits = m.weights.map(
    (w, k) =>
      w.reduce((sum, v, j) => sum + v * z[j], m.bias[k]) / (m.temperature ?? 1),
  );
  const top = Math.max(...logits),
    exp = logits.map((v) => Math.exp(v - top)),
    sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}
export function infer(m: Model, x: number[], ts: number) {
  validateModel(m);
  if (x.length !== m.features.length || x.some((v) => !Number.isFinite(v)))
    throw new Error("Invalid ML features");
  const empty = {
    label: null,
    scores: null,
    rawLabel: null,
    topScore: null,
    margin: null,
    evidence: [] as { feature: string; value: number; contribution: number }[],
  };
  if (ts <= m.trainedThroughTs)
    return {
      ...empty,
      state: "before_training_cutoff",
      reason: "This model used observations after the requested replay time.",
    };
  const z = x.map((v, j) => (v - m.means[j]) / m.scales[j]);
  if (z.some((v) => !Number.isFinite(v) || Math.abs(v) > (m.maxAbsZ ?? 50)))
    return {
      ...empty,
      state: "out_of_distribution",
      reason:
        "Features are outside the supported training scale; score withheld.",
    };
  const scores = scoreModel(m, x),
    ranked = scores
      .map((score, k) => ({ score, k }))
      .sort((a, b) => b.score - a.score),
    best = ranked[0],
    margin = best.score - ranked[1].score;
  const evidence = x
    .map((value, j) => ({
      feature: m.features[j],
      value,
      contribution: (m.weights[best.k][j] - m.weights[ranked[1].k][j]) * z[j],
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3);
  const uncertain =
    best.score < (m.minScore ?? 0) || margin < (m.minMargin ?? 0);
  return {
    state: uncertain
      ? "uncertain"
      : m.version === 2
        ? "advisory_model_score"
        : "advisory_uncalibrated",
    label: uncertain ? null : CLASSES[best.k],
    rawLabel: CLASSES[best.k],
    scores,
    topScore: best.score,
    margin,
    evidence,
    reason: uncertain
      ? "Ambiguous class scores; no diagnostic label assigned."
      : "Advisory class score, not a physical failure probability. Feature contributions are model explanations, not causes.",
  };
}
