import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { cli, database, httpOrigin, startServer, stopProcess } from "./cli.js";
import { connectNode } from "./connection.js";
import { DEFAULT_FOLDER, importDataset } from "./import.js";
const args = process.argv.slice(2),
  folder = args.find((a) => !a.startsWith("--")) ?? DEFAULT_FOLDER;
let server: ReturnType<typeof startServer> | undefined,
  child: ReturnType<typeof spawn> | undefined;
let shuttingDown = false;
function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopProcess(child);
  stopProcess(server);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", stop);
async function alive() {
  try {
    return (
      await fetch(`${httpOrigin}/v1/ping`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
}
try {
  if (!(await alive())) {
    server = startServer();
    for (let i = 0; !(await alive()); i++) {
      if (i >= 60 || server.exitCode !== null)
        throw new Error("Local SpacetimeDB failed to start");
      await delay(500);
    }
  }
  cli([
    "publish",
    "--server",
    httpOrigin,
    "--module-path",
    "spacetimedb",
    "--yes=skip-login",
    database,
  ]);
  console.log(`Database ready: ${database} at ${httpOrigin}`);
  if (args.includes("--mock"))
    child = spawn(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "bridge/main.ts",
        "--mock",
        "--count",
        "86400",
      ],
      { stdio: "inherit", windowsHide: true },
    );
  else {
    const conn = await connectNode(true);
    try {
      await importDataset(conn, folder);
    } finally {
      conn.disconnect();
    }
  }
  console.log(
    "Backend ready. Run npm run watch in another terminal. Ctrl+C stops processes started here.",
  );
  if (child)
    child.on("exit", (code) => {
      if (code) process.exitCode = code;
      stop();
    });
  if (!server && !child)
    console.log("Using your existing local server; it remains running.");
} catch (error) {
  stop();
  throw error;
}
