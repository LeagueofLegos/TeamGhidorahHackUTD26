import type { Facility } from "./dataset.js";
export const CLASSES = ["normal", "pipeline_leak", "pump_degradation"] as const;
export const FEATURES = [
  "flow_capacity_ratio",
  "received_shortfall_fraction",
  "pump_pressure_ratio",
  "pipeline_pressure_ratio",
] as const;
export type Model = {
  version: 1;
  kind: "softmax";
  classes: string[];
  features: string[];
  trainedThroughTs: number;
  means: number[];
  scales: number[];
  weights: number[][];
  bias: number[];
};
export function features(
  f: Facility,
  disposalPressure: number,
  get: (asset: string, metric: string) => number | undefined,
): number[] | null {
  const flow = get(f.pump.id, "flow_bpd"),
    received = get(f.pipeline.id, "receive_flow_bpd");
  const pressure = get(f.pump.id, "discharge_psi"),
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
  return [
    flow / f.pump.max_flow_bpd,
    (flow - received) / flow,
    pressure / (disposalPressure + 150),
    pipeline / (disposalPressure + 50),
  ];
}
export function validateModel(m: Model) {
  if (
    m.version !== 1 ||
    m.kind !== "softmax" ||
    JSON.stringify(m.classes) !== JSON.stringify(CLASSES) ||
    JSON.stringify(m.features) !== JSON.stringify(FEATURES) ||
    !Number.isSafeInteger(m.trainedThroughTs) ||
    m.means.length !== 4 ||
    m.scales.length !== 4 ||
    m.weights.length !== 3 ||
    m.bias.length !== 3 ||
    m.weights.some((w) => w.length !== 4) ||
    [...m.means, ...m.scales, ...m.weights.flat(), ...m.bias].some(
      (x) => !Number.isFinite(x),
    ) ||
    m.scales.some((x) => x <= 0)
  )
    throw new Error("Invalid model artifact");
}
export function infer(m: Model, x: number[], ts: number) {
  validateModel(m);
  if (x.length !== 4 || x.some((v) => !Number.isFinite(v)))
    throw new Error("Invalid ML features");
  if (ts <= m.trainedThroughTs)
    return { state: "before_training_cutoff", label: null, scores: null };
  const z = x.map((v, j) => (v - m.means[j]) / m.scales[j]);
  const logits = m.weights.map((w, k) =>
    w.reduce((sum, v, j) => sum + v * z[j], m.bias[k]),
  );
  const top = Math.max(...logits),
    exps = logits.map((v) => Math.exp(v - top)),
    sum = exps.reduce((a, b) => a + b, 0);
  const scores = exps.map((v) => v / sum),
    best = scores.indexOf(Math.max(...scores));
  return { state: "advisory_uncalibrated", label: CLASSES[best], scores };
}
