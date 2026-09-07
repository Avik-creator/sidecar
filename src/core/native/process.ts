import { execFileSync } from "node:child_process";

export type AliveCheck = (pid: number) => boolean;

// Signal 0 probes without killing; EPERM means the process exists but belongs to someone else.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Pid of the first process with exactly this name, or null when none runs or pgrep is unavailable.
export function findProcessPid(name: string): number | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const out = execFileSync("pgrep", ["-x", name], { encoding: "utf8", timeout: 2000 });
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Pid per working directory for every process with this name, so a thread can be matched to its process.
export function processesByCwd(name: string, exec = runCommand): Map<string, number> {
  const out = new Map<string, number>();
  if (process.platform === "win32") {
    return out;
  }
  let listing: string;
  try {
    listing = exec("ps", ["-axo", "pid=,comm="]);
  } catch {
    return out;
  }
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || (match[2] ?? "").split("/").at(-1) !== name) {
      continue;
    }
    const pid = Number(match[1]);
    const cwd = cwdOf(pid, exec);
    if (cwd && !out.has(cwd)) {
      out.set(cwd, pid);
    }
  }
  return out;
}

function cwdOf(pid: number, exec: (command: string, args: string[]) => string): string | null {
  try {
    const line = exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
      .split("\n")
      .find((entry) => entry.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function runCommand(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
}
