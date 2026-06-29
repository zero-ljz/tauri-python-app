import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..", "..");
const backendDir = join(rootDir, "backend");
const venvPython =
  process.platform === "win32"
    ? join(backendDir, ".venv", "Scripts", "python.exe")
    : join(backendDir, ".venv", "bin", "python");
const python = existsSync(venvPython)
  ? venvPython
  : process.env.PYTHON_SIDECAR_PYTHON || "python";

const result = spawnSync(python, process.argv.slice(2), {
  cwd: rootDir,
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
