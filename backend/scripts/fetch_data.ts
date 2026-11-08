import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const allowed = [
  "full_week",
  "snapshot_2026-10-08T1200",
  "snapshot_2026-10-09T0330",
  "snapshot_2026-10-10T0900",
  "mock_test_2026-10-10T1530",
];
const selected = process.argv[2] ?? "snapshot_2026-10-08T1200";
if (selected !== "all" && !allowed.includes(selected))
  throw new Error("Unknown practice folder");
// Pin challenge inputs so demo/evaluation results remain reproducible.
const revision = "135ba4c8348357457420a1111df80ec1906bcbdb";
for (const folder of selected === "all" ? allowed : [selected]) {
  const directory = resolve("data/HackUTD-ZeroDay/history", folder);
  await mkdir(directory, { recursive: true });
  for (const file of ["network.json", "ops.json", "telemetry.csv"]) {
    const response = await fetch(
      `https://raw.githubusercontent.com/nihaal419/HackUTD-ZeroDay/${revision}/history/${folder}/${file}`,
    );
    if (!response.ok)
      throw new Error(`Download failed: ${file}, HTTP ${response.status}`);
    await writeFile(
      resolve(directory, file),
      Buffer.from(await response.arrayBuffer()),
    );
    console.log(`Saved ${file}`);
  }
}
