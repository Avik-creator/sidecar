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
