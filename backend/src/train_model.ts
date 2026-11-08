// Offline only: explicit practice labels never enter ingestion, inference or planning.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadDataset } from "./dataset.js";
import {
  CLASSES,
  createMLContext,
  advanceMLContext,
  contextFeatures,
  infer,
  validateModel,
  type Model,
} from "./ml.js";
import {
  fitModel,
  metrics,
  chooseTemperature,
  type TrainingSample,
} from "./ml_training.js";
const [folder, labelsPath] = process.argv.slice(2);
if (!folder || !labelsPath)
  throw new Error(
    "Usage: npm run train -- <practice-folder> <practice-answer-key.json>",
  );
const d = await loadDataset(folder),
  labels = JSON.parse(await readFile(labelsPath, "utf8")) as {
    id: string;
    facility: string;
    category: string;
    onset_unix: number;
    end_unix: number;
  }[];
if (
  !Array.isArray(labels) ||
  labels.some(
    (e) =>
      !e.id ||
      !e.facility ||
      !["pump_failure", "pipeline_leak", "pump_degradation"].includes(
        e.category,
      ) ||
      !Number.isSafeInteger(e.onset_unix) ||
      !Number.isSafeInteger(e.end_unix) ||
      e.end_unix <= e.onset_unix,
  )
)
  throw new Error("Invalid practice labels");
const split = (fraction: number) =>
  d.firstTs + Math.floor(((d.nowTs - d.firstTs) * fraction) / 300) * 300;
const trainEnd = split(0.3),
  validationEnd = split(0.45),
  samples: TrainingSample[] = [],
  context = createMLContext();
let cursor = 0;
while (cursor < d.readings.length) {
  const ts = d.readings[cursor].ts_unix,
    rows = [];
  while (cursor < d.readings.length && d.readings[cursor].ts_unix === ts)
    rows.push(d.readings[cursor++]);
  advanceMLContext(context, d.network, rows);
  for (const sys of d.network.systems)
    for (const f of sys.facilities) {
      const x = contextFeatures(context, f.id);
      if (!x) continue;
      const event = labels.find(
        (e) =>
          e.facility === f.id &&
          e.onset_unix <= ts &&
          ts < e.end_unix &&
          e.category !== "pump_failure",
      );
      samples.push({
        x,
        y: event
          ? CLASSES.indexOf(event.category as (typeof CLASSES)[number])
          : 0,
        ts,
        facilityId: f.id,
      });
    }
}
const train = samples.filter((r) => r.ts <= trainEnd),
  validation = samples.filter((r) => r.ts > trainEnd && r.ts <= validationEnd),
  test = samples.filter((r) => r.ts > validationEnd);
if (!validation.length || !test.length)
  throw new Error(
    "Training, validation and test periods must all have observations",
  );
const candidates = [];
for (const [dimensions, l2] of [
  [4, 0.001],
  [8, 0.001],
  [8, 0.01],
]) {
  console.log(`Fit candidate: ${dimensions} causal features, L2 ${l2}`);
  const model = fitModel(train, dimensions, l2),
    evaluation = metrics(model, validation);
  candidates.push({ model, dimensions, l2, evaluation });
}
candidates.sort(
  (a, b) =>
    b.evaluation.macroF1 - a.evaluation.macroF1 ||
    a.evaluation.negativeLogLikelihood - b.evaluation.negativeLogLikelihood,
);
const selected = candidates[0],
  model = selected.model;
model.temperature = chooseTemperature(model, validation);
// Model selection and temperature used validation observations too. Guard against ALL such future data.
model.trainedThroughTs = validationEnd;
validateModel(model);
const baseline = JSON.parse(
  await readFile("models/baseline-v1.json", "utf8"),
) as Model;
validateModel(baseline);
const events = labels.filter(
    (e) => e.category !== "pump_failure" && e.onset_unix > validationEnd,
  ),
  detections = new Map<string, number>();
const streak = new Map<
  string,
  { label: string; last: number; count: number }
>();
let falseAlarmEpisodes = 0,
  confirmedEpisodes = 0;
for (const r of test) {
  const prediction = infer(model, r.x.slice(0, model.features.length), r.ts),
    label = prediction.label;
  if (!label || label === "normal") {
    streak.delete(r.facilityId);
    continue;
  }
  const old = streak.get(r.facilityId),
    count =
      old && old.label === label && r.ts - old.last <= 600 ? old.count + 1 : 1;
  streak.set(r.facilityId, { label, last: r.ts, count });
  if (count !== 3) continue;
  confirmedEpisodes++;
  const matching = labels.find(
    (e) =>
      e.facility === r.facilityId &&
      e.category === label &&
      e.onset_unix <= r.ts &&
      r.ts < e.end_unix,
  );
  if (!matching) falseAlarmEpisodes++;
  else if (
    events.some((e) => e.id === matching.id) &&
    !detections.has(matching.id)
  )
    detections.set(matching.id, r.ts);
}
const eventResults = events.map((e) => ({
  id: e.id,
  facilityId: e.facility,
  category: e.category,
  onsetTs: e.onset_unix,
  detectedTs: detections.get(e.id) ?? null,
  delayMinutes: detections.has(e.id)
    ? (detections.get(e.id)! - e.onset_unix) / 60
    : null,
}));
const report = {
  version: 2,
  method:
    "Chronological first 30% train, next 15% validation/model selection/temperature, final 55% test. Causal running-sample windows. Same synthetic network; not independent field validation.",
  fitThrough: new Date(trainEnd * 1000).toISOString(),
  trainedThrough: new Date(validationEnd * 1000).toISOString(),
  trainRows: train.length,
  validationRows: validation.length,
  testRows: test.length,
  selection: {
    dimensions: selected.dimensions,
    l2: selected.l2,
    temperature: model.temperature,
    candidates: candidates.map((c) => ({
      dimensions: c.dimensions,
      l2: c.l2,
      validationMacroF1: c.evaluation.macroF1,
      validationLogLoss: c.evaluation.negativeLogLikelihood,
    })),
  },
  baselineSameTest: metrics(baseline, test),
  testForcedClassification: metrics(model, test),
  testWithAbstention: metrics(model, test, true),
  eventEvaluation: {
    confirmationSamples: 3,
    newHeldOutEvents: eventResults,
    eventsDetected: eventResults.filter((e) => e.detectedTs !== null).length,
    totalEvents: eventResults.length,
    confirmedEpisodes,
    falseAlarmEpisodes,
    notice:
      "Event-onset delay excludes events already underway at the test boundary. Pump-off gaps can split one true event into multiple confirmed episodes.",
  },
  notice:
    "Temperature is fitted on synthetic validation data. Scores are advisory class scores, not real equipment failure probabilities. ML never actuates shutdowns; explicit fault/threshold forecasts and modeled cost policy govern the software-only simulation.",
};
await mkdir("models", { recursive: true });
await writeFile("models/anomaly.json", JSON.stringify(model, null, 2) + "\n");
await writeFile(
  "models/evaluation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      selection: report.selection,
      baselineMacroF1: report.baselineSameTest.macroF1,
      newMacroF1: report.testForcedClassification.macroF1,
      coverage: report.testWithAbstention.coverage,
      acceptedAccuracy: report.testWithAbstention.accuracyAmongAccepted,
      events: report.eventEvaluation,
    },
    null,
    2,
  ),
);
