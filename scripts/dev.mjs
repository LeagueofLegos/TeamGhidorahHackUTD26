import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)),
  children = [];
let stopped = false;
process.env.VITE_SPACETIME_URI ??= process.env.SPACETIME_URI??'ws://127.0.0.1:3000';
process.env.VITE_SPACETIME_DATABASE ??= process.env.SPACETIME_DATABASE??'ghidorah-demo';
function stop() {
  if (stopped) return;
  stopped = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {}
    } else child.kill("SIGTERM");
  }
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", stop);
for (const [folder, script] of [
  ["backend", "dev"],
  ["frontend", "dev"],
]) {
  const child = spawn(
    process.execPath,
    [process.env.npm_execpath, "--prefix", folder, "run", script,...(folder==='backend'&&process.argv.length>2?['--',...process.argv.slice(2)]:[])],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.on("exit", (code) => {
    if (!stopped) {
      if(folder==='backend'&&code===0)return;
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
console.log(
  `Ghidorah: dashboard http://127.0.0.1:5173 · database ${process.env.VITE_SPACETIME_URI}`,
);
