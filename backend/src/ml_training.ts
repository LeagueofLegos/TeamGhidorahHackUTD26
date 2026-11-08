// Offline training/evaluation helpers. The database module never imports this file.
import {
  CLASSES,
  FEATURES,
  TEMPORAL_FEATURES,
  infer,
  scoreModel,
  type Model,
} from "./ml.js";
export type TrainingSample = {
  x: number[];
  y: number;
  ts: number;
  facilityId: string;
};
export function fitModel(
  train: TrainingSample[],
  dimensions: number,
  l2: number,
): Model {
  if (!train.length) throw new Error("No training samples");
  const means = Array.from(
    { length: dimensions },
    (_, j) => train.reduce((sum, r) => sum + r.x[j], 0) / train.length,
  );
  const scales = means.map((mean, j) =>
    Math.max(
      1e-6,
      Math.sqrt(
        train.reduce((sum, r) => sum + (r.x[j] - mean) ** 2, 0) / train.length,
      ),
    ),
  );
  const counts = CLASSES.map((_, k) => train.filter((r) => r.y === k).length);
  if (counts.some((n) => !n))
    throw new Error("Training period must contain every class");
  const cutoff = Math.max(...train.map((r) => r.ts));
  const m: Model = {
    version: 2,
    kind: "softmax",
    classes: [...CLASSES],
    features: dimensions === 4 ? [...FEATURES] : [...TEMPORAL_FEATURES],
    trainedThroughTs: cutoff,
    fitThroughTs: cutoff,
    means,
    scales,
    weights: CLASSES.map(() => Array(dimensions).fill(0)),
    bias: [0, 0, 0],
    temperature: 1,
    minScore: 0.6,
    minMargin: 0.15,
    maxAbsZ: 25,
  };
  const rows = train.map((r) => ({
    ...r,
    x: r.x.slice(0, dimensions).map((v, j) => (v - means[j]) / scales[j]),
  }));
  for (let epoch = 0; epoch < 800; epoch++) {
    const dw = CLASSES.map(() => Array(dimensions).fill(0)),
      db = [0, 0, 0];
    for (const r of rows) {
      const logits = m.weights.map((w, k) =>
          w.reduce((sum, v, j) => sum + v * r.x[j], m.bias[k]),
        ),
        top = Math.max(...logits),
        exp = logits.map((v) => Math.exp(v - top)),
        sum = exp.reduce((a, b) => a + b, 0),
        weight = train.length / (3 * counts[r.y]);
      for (let k = 0; k < 3; k++) {
        const error = (exp[k] / sum - Number(k === r.y)) * weight;
        db[k] += error;
        for (let j = 0; j < dimensions; j++) dw[k][j] += error * r.x[j];
      }
    }
    for (let k = 0; k < 3; k++) {
      m.bias[k] -= (0.08 * db[k]) / rows.length;
      for (let j = 0; j < dimensions; j++)
        m.weights[k][j] -=
          0.08 * (dw[k][j] / rows.length + l2 * m.weights[k][j]);
    }
  }
  return m;
}
export function metrics(m: Model, rows: TrainingSample[], gate = false) {
  const confusion = CLASSES.map(() => [0, 0, 0]),
    abstentions = [0, 0, 0];
  let nll = 0,
    brier = 0,
    correct = 0,
    accepted = 0;
  const bins = Array.from({ length: 10 }, () => ({
    count: 0,
    score: 0,
    correct: 0,
  }));
  for (const r of rows) {
    const x = r.x.slice(0, m.features.length),
      scores = scoreModel(m, x),
      best = scores.indexOf(Math.max(...scores)),
      out = gate ? infer(m, x, r.ts) : null;
    nll -= Math.log(Math.max(1e-15, scores[r.y]));
    brier += scores.reduce((s, p, k) => s + (p - Number(k === r.y)) ** 2, 0);
    const bin = bins[Math.min(9, Math.floor(scores[best] * 10))];
    bin.count++;
    bin.score += scores[best];
    bin.correct += Number(best === r.y);
    if (gate && !out?.label) {
      abstentions[r.y]++;
      continue;
    }
    confusion[r.y][best]++;
    accepted++;
    correct += Number(best === r.y);
  }
  const perClass = CLASSES.map((label, k) => {
    const tp = confusion[k][k],
      support = confusion[k].reduce((a, b) => a + b, 0) + abstentions[k],
      predicted = confusion.reduce((s, r) => s + r[k], 0),
      precision = predicted ? tp / predicted : 0,
      recall = support ? tp / support : 0;
    return {
      label,
      support,
      abstained: abstentions[k],
      precision,
      recall,
      f1:
        precision + recall
          ? (2 * precision * recall) / (precision + recall)
          : 0,
    };
  });
  return {
    rows: rows.length,
    confusion,
    perClass,
    macroF1: perClass.reduce((s, r) => s + r.f1, 0) / 3,
    coverage: rows.length ? accepted / rows.length : 0,
    accuracyAmongAccepted: accepted ? correct / accepted : 0,
    negativeLogLikelihood: nll / rows.length,
    brierScore: brier / rows.length,
    expectedCalibrationError: bins.reduce(
      (s, b) =>
        s +
        (b.count
          ? (Math.abs(b.correct / b.count - b.score / b.count) * b.count) /
            rows.length
          : 0),
      0,
    ),
  };
}
export function chooseTemperature(m: Model, validation: TrainingSample[]) {
  let best = 1,
    loss = Infinity;
  for (const temperature of [0.35, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 3]) {
    const score = metrics(
      { ...m, temperature },
      validation,
    ).negativeLogLikelihood;
    if (score < loss) {
      loss = score;
      best = temperature;
    }
  }
  return best;
}
