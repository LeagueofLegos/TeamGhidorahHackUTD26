// Offline tool only: explicit practice labels never enter the running application.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadDataset } from "./dataset.js";
import { CLASSES, FEATURES, features, infer, type Model } from "./ml.js";
const [folder, labelsPath] = process.argv.slice(2);
if (!folder || !labelsPath)
  throw new Error(
    "Usage: npm run train -- <practice-folder> <practice-answer-key.json>",
  );
const d = await loadDataset(folder);
const labels = JSON.parse(await readFile(labelsPath, "utf8")) as {
  facility: string;
  category: string;
  onset_unix: number;
  end_unix: number;
}[];
const cutoff =
  d.firstTs + Math.floor(((d.nowTs - d.firstTs) * 0.3) / 300) * 300;
const samples: { x: number[]; y: number; ts: number }[] = [];
let cursor = 0;
while (cursor < d.readings.length) {
  const ts = d.readings[cursor].ts_unix,
    frame = new Map<string, number>();
  while (cursor < d.readings.length && d.readings[cursor].ts_unix === ts) {
    const r = d.readings[cursor++];
    frame.set(`${r.asset_id}/${r.metric}`, r.value);
  }
  for (const s of d.network.systems)
    for (const f of s.facilities) {
      const x = features(f, s.disposal_site.pressure_psi, (a, m) =>
        frame.get(`${a}/${m}`),
      );
      if (!x) continue;
      const event = labels.find(
        (e) =>
          e.facility === f.id &&
          e.onset_unix <= ts &&
          ts < e.end_unix &&
          e.category !== "pump_failure",
      );
      const y = event
        ? CLASSES.indexOf(event.category as (typeof CLASSES)[number])
        : 0;
      if (y >= 0) samples.push({ x, y, ts });
    }
}
const train = samples.filter((s) => s.ts <= cutoff),
  test = samples.filter((s) => s.ts > cutoff);
const means = FEATURES.map(
  (_, j) => train.reduce((s, r) => s + r.x[j], 0) / train.length,
);
const scales = means.map((m, j) =>
  Math.max(
    1e-6,
    Math.sqrt(train.reduce((s, r) => s + (r.x[j] - m) ** 2, 0) / train.length),
  ),
);
const counts = CLASSES.map((_, k) => train.filter((s) => s.y === k).length);
if (counts.some((n) => n === 0))
  throw new Error("Training period must contain every class");
const model: Model = {
  version: 1,
  kind: "softmax",
  classes: [...CLASSES],
  features: [...FEATURES],
  trainedThroughTs: cutoff,
  means,
  scales,
  weights: CLASSES.map(() => [0, 0, 0, 0]),
  bias: [0, 0, 0],
};
const rows = train.map((r) => ({
  ...r,
  x: r.x.map((v, j) => (v - means[j]) / scales[j]),
}));
// Deterministic, class-balanced full-batch gradient descent; fixed settings before evaluation.
for (let epoch = 0; epoch < 800; epoch++) {
  const dw = CLASSES.map(() => [0, 0, 0, 0]),
    db = [0, 0, 0];
  for (const r of rows) {
    const logits = model.weights.map((w, k) =>
      w.reduce((a, v, j) => a + v * r.x[j], model.bias[k]),
    );
    const top = Math.max(...logits),
      exp = logits.map((x) => Math.exp(x - top)),
      sum = exp.reduce((a, b) => a + b, 0);
    const weight = train.length / (3 * counts[r.y]);
    for (let k = 0; k < 3; k++) {
      const error = (exp[k] / sum - Number(k === r.y)) * weight;
      db[k] += error;
      for (let j = 0; j < 4; j++) dw[k][j] += error * r.x[j];
    }
  }
  for (let k = 0; k < 3; k++) {
    model.bias[k] -= (0.08 * db[k]) / rows.length;
    for (let j = 0; j < 4; j++)
      model.weights[k][j] -=
        0.08 * (dw[k][j] / rows.length + 0.001 * model.weights[k][j]);
  }
}
const confusion = CLASSES.map(() => [0, 0, 0]);
for (const r of test)
  confusion[r.y][CLASSES.indexOf(infer(model, r.x, r.ts).label!)]++;
const metrics = CLASSES.map((label, k) => {
  const tp = confusion[k][k],
    support = confusion[k].reduce((a, b) => a + b, 0),
    predicted = confusion.reduce((s, row) => s + row[k], 0);
  const precision = predicted ? tp / predicted : 0,
    recall = support ? tp / support : 0;
  return {
    label,
    support,
    precision,
    recall,
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  };
});
const report = {
  method:
    "Temporal split: first 30% train, remaining 70% held out. Running pumps only. Same synthetic practice network; not an independent field validation.",
  trainedThrough: new Date(cutoff * 1000).toISOString(),
  trainRows: train.length,
  testRows: test.length,
  classes: CLASSES,
  confusion,
  metrics,
  macroF1: metrics.reduce((s, m) => s + m.f1, 0) / 3,
  notice:
    "Uncalibrated model scores; rules remain authoritative for fault and threshold detection. No real equipment controls.",
};
await mkdir("models", { recursive: true });
await writeFile("models/anomaly.json", JSON.stringify(model, null, 2) + "\n");
await writeFile(
  "models/evaluation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
