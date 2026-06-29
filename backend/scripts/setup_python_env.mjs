import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const venvDir = join(backendDir, ".venv");
const requirementsPath = join(backendDir, "requirements.txt");
const venvPython =
  process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: backendDir,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function canImportPydantic() {
  if (!existsSync(venvPython)) {
    return false;
  }
  const result = spawnSync(
    venvPython,
    ["-c", "import pydantic; print(pydantic.__version__)"],
    {
      cwd: backendDir,
      encoding: "utf8",
    },
  );
  if (result.status === 0) {
    process.stdout.write(`Python sidecar env ready: pydantic ${result.stdout.trim()}\n`);
    return true;
  }
  return false;
}

function pythonCandidates() {
  const candidates = [];
  if (process.env.PYTHON_SIDECAR_PYTHON) {
    candidates.push({
      command: process.env.PYTHON_SIDECAR_PYTHON,
      args: [],
    });
  }
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3"] });
  }
  candidates.push({ command: "python", args: [] });
  candidates.push({ command: "python3", args: [] });
  return candidates;
}

function createVenv() {
  for (const candidate of pythonCandidates()) {
    const probe = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
      shell: false,
    });
    if (probe.status !== 0) {
      continue;
    }
    process.stdout.write(
      `Creating Python sidecar env with ${candidate.command} ${candidate.args.join(" ")}\n`,
    );
    run(candidate.command, [...candidate.args, "-m", "venv", venvDir]);
    return;
  }
  process.stderr.write(
    "No Python interpreter found. Install Python 3.10+ or set PYTHON_SIDECAR_PYTHON.\n",
  );
  process.exit(1);
}

if (!canImportPydantic()) {
  if (!existsSync(venvPython)) {
    createVenv();
  }
  run(venvPython, ["-m", "pip", "install", "-r", requirementsPath]);
  canImportPydantic();
}
