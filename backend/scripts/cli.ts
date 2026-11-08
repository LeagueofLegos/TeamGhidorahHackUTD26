import {
  execFileSync,
  spawn,
  type SpawnOptions,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
export const root = resolve(process.env.SPACETIME_ROOT ?? ".runtime");
export const database = process.env.SPACETIME_DATABASE ?? "ghidorah-demo";
export const uri = process.env.SPACETIME_URI ?? "ws://127.0.0.1:3000";
const local = new URL(uri);
if (!["127.0.0.1", "localhost", "[::1]"].includes(local.hostname))
  throw new Error(
    "Prototype startup and automatic authorization are localhost-only.",
  );
const installed = join(
  process.env.LOCALAPPDATA ?? "",
  "SpacetimeDB",
  "bin",
  "current",
  "spacetimedb-cli.exe",
);
export const executable =
  process.env.SPACETIME_CLI ??
  (existsSync(installed) ? installed : "spacetime");
export const httpOrigin = uri.replace(/^ws/, "http").replace(/\/$/, "");
export function cli(args: string[]) {
  mkdirSync(root, { recursive: true });
  return execFileSync(executable, ["--root-dir", root, ...args], {
    stdio: "inherit",
    windowsHide: true,
    timeout: 180000,
  });
}
export function startServer(options: SpawnOptions = {}) {
  mkdirSync(root, { recursive: true });
  return spawn(
    executable,
    [
      "--root-dir",
      root,
      "start",
      "--listen-addr",
      `127.0.0.1:${local.port || 3000}`,
      "--non-interactive",
    ],
    { stdio: "inherit", windowsHide: true, ...options },
  );
}
export function stopProcess(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10000,
      });
    } catch {}
  } else child.kill("SIGTERM");
}
export function normalizeBindings(directory = "client/module_bindings") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) normalizeBindings(path);
    else if (path.endsWith(".ts"))
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
          (_match, a, b, c) =>
            a + b + (/\.(js|json)$/.test(b) ? "" : ".js") + c,
        ),
      );
  }
}
if (process.argv[1]?.endsWith("cli.ts")) {
  const action = process.argv[2];
  if (action === "generate") {
    cli([
      "generate",
      "--lang",
      "typescript",
      "--out-dir",
      "client/module_bindings",
      "--module-path",
      "spacetimedb",
      "--yes",
    ]);
    normalizeBindings();
  } else if (action === "build") cli(["build", "--module-path", "spacetimedb"]);
  else if (action === "publish")
    cli([
      "publish",
      "--server",
      httpOrigin,
      "--module-path",
      "spacetimedb",
      "--yes=skip-login",
      database,
    ]);
  else if (action === "server") startServer();
  else throw new Error("Expected build, generate, publish, or server");
}
