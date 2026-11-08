import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { cli, database, httpOrigin, startServer, stopProcess } from "./cli.js";
import { connectNode } from "./connection.js";
import { DEFAULT_FOLDER, importDataset } from "./import.js";
const args = process.argv.slice(2);
let folder=DEFAULT_FOLDER,port:string|undefined,tank:string|undefined,mock=false;
for(let i=0;i<args.length;i++) {
  const arg=args[i];
  if(arg==='--mock')mock=true;
  else if(['--dataset','--port','--tank'].includes(arg)) {const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`Missing value for ${arg}`);if(arg==='--dataset')folder=value;else if(arg==='--port')port=value;else tank=value;}
  else if(!arg.startsWith('-'))folder=arg;
  else throw new Error(`Unknown startup option ${arg}. Run npm.cmd start -- --help from the root.`);
}
if(mock&&port)throw new Error('Choose --mock or --port, not both.');
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
  if (mock||port)
    child = spawn(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "bridge/main.ts",
        ...(mock?["--mock","--count","86400"]:["--port",port!]),
        "--dataset",folder,
        ...(tank?["--tank",tank]:[]),
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
