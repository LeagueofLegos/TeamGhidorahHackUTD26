import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { loadDataset } from "./dataset.js";
import { analyzeDataset } from "./detection.js";

const history = process.env.GHIDORAH_HISTORY_DIR ??
  "data/HackUTD-ZeroDay/history";
let fullWeek: ReturnType<typeof loadDataset> | undefined;
const full = () => fullWeek ??= loadDataset(join(history, "full_week"));

test("practice week has 23 detected episodes and no remaining alerts", async () => {
  const dataset = await full();
  const result = analyzeDataset(dataset);
  assert.equal(dataset.readings.length, 393120);
  assert.equal(result.events.length, 23);
  assert.equal(result.alerts.length, 0);
  const counts = (category: string) =>
    result.events.filter(event => event.category === category).length;
  assert.equal(counts("pump_failure"), 13);
  assert.equal(counts("pipeline_leak"), 5);
  assert.equal(counts("pump_degradation"), 5);
});

for (const [folder, expectedFailures] of [
  ["snapshot_2026-10-08T1200", 3],
  ["snapshot_2026-10-09T0330", 1],
  ["snapshot_2026-10-10T0900", 3]
] as const) {
  test(`${folder}: snapshot equals full-week analysis cut at the same time`, async () => {
    const snapshot = await loadDataset(join(history, folder));
    const observed = analyzeDataset(snapshot);
    const replay = analyzeDataset(await full(), snapshot.nowTs);
    assert.equal(observed.predictions.length, expectedFailures);
    assert.deepEqual(replay, observed);
    assert.ok(observed.events.every(event => event.detectedAtTs <= snapshot.nowTs));
  });
}
