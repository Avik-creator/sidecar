import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cwdFromPayload, hookOutcome, sessionIdFromPayload } from "../src/core/hooks/events.js";
import {
  hooksStatus,
  installHooks,
  uninstallHooks,
  writeHelper,
  type HookInstallPaths,
} from "../src/core/hooks/install.js";
import { clearSpool, readSpool } from "../src/core/hooks/spool.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-hooks-"));
  tmpDirs.push(dir);
  return dir;
}

// Mirrors the shape of a real machine: other tools already own entries in these files.
function fixture(): HookInstallPaths {
  const dir = tmp();
  const paths: HookInstallPaths = {
    helper: path.join(dir, "sidecar", "bin", "sidecar-hook"),
    backups: path.join(dir, "sidecar", "backups"),
    configs: {
      claude: path.join(dir, "claude", "settings.json"),
      codex: path.join(dir, "codex", "hooks.json"),
      cursor: path.join(dir, "cursor", "hooks.json"),
    },
  };
  fs.mkdirSync(path.dirname(paths.configs.claude), { recursive: true });
  fs.mkdirSync(path.dirname(paths.configs.codex), { recursive: true });
  fs.mkdirSync(path.dirname(paths.configs.cursor), { recursive: true });
  fs.writeFileSync(
    paths.configs.claude,
    JSON.stringify(
      {
        permissions: { allow: ["mcp__pencil"] },
        model: "opus[1m]",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
          Stop: [{ hooks: [{ type: "command", command: "$SUPERSET_HOME_DIR/hooks/notify.sh" }] }],
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    paths.configs.codex,
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/x/.superset/hooks/notify.sh" }] }],
          SubagentStart: [
            { matcher: "tldraw-offline", hooks: [{ type: "command", command: "sh /x/inject.sh" }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    paths.configs.cursor,
    JSON.stringify(
      {
        version: 1,
        hooks: {
          afterAgentResponse: [{ command: "/var/lib/surface/cursor", id: "surface-cursor-collector", timeout: 5 }],
          stop: [{ command: "/x/.superset/hooks/cursor-hook.sh Stop" }],
        },
      },
      null,
      2,
    ),
  );
  return paths;
}

function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
}

function commandsFor(doc: Record<string, any>, event: string): string[] {
  const entries: unknown[] = doc.hooks?.[event] ?? [];
  return entries.flatMap((entry: any) =>
    typeof entry.command === "string"
      ? [entry.command]
      : (entry.hooks ?? []).map((child: any) => String(child.command)),
  );
}

describe("hook installation", () => {
  it("adds Sidecar entries without dropping other tools' hooks", () => {
    const paths = fixture();
    installHooks(paths);

    const claude = read(paths.configs.claude);
    expect(commandsFor(claude, "PreToolUse")).toContain("rtk hook claude");
    expect(commandsFor(claude, "Stop")).toContain("$SUPERSET_HOME_DIR/hooks/notify.sh");
    expect(commandsFor(claude, "Stop").some((c) => c.includes("sidecar-hook"))).toBe(true);
    expect(claude.permissions.allow).toEqual(["mcp__pencil"]);
    expect(claude.model).toBe("opus[1m]");

    const codex = read(paths.configs.codex);
    expect(commandsFor(codex, "SessionStart")).toContain("/x/.superset/hooks/notify.sh");
    expect(commandsFor(codex, "SubagentStart")).toContain("sh /x/inject.sh");
    expect(commandsFor(codex, "Stop").some((c) => c.includes("sidecar-hook"))).toBe(true);

    const cursor = read(paths.configs.cursor);
    expect(cursor.version).toBe(1);
    expect(commandsFor(cursor, "afterAgentResponse")).toContain("/var/lib/surface/cursor");
    expect(commandsFor(cursor, "stop")).toContain("/x/.superset/hooks/cursor-hook.sh Stop");
    expect(cursor.hooks.stop.some((e: any) => e.id === "sidecar")).toBe(true);
  });

  it("is idempotent — reinstalling does not duplicate entries", () => {
    const paths = fixture();
    installHooks(paths);
    const first = read(paths.configs.claude).hooks.Stop.length;
    installHooks(paths);
    installHooks(paths);
    const after = read(paths.configs.claude);
    expect(after.hooks.Stop.length).toBe(first);
    expect(commandsFor(after, "Stop").filter((c) => c.includes("sidecar-hook"))).toHaveLength(1);
    expect(commandsFor(after, "Stop")).toContain("$SUPERSET_HOME_DIR/hooks/notify.sh");
  });

  it("uninstall removes only Sidecar entries", () => {
    const paths = fixture();
    installHooks(paths);
    uninstallHooks(paths);

    const claude = read(paths.configs.claude);
    expect(commandsFor(claude, "Stop")).toEqual(["$SUPERSET_HOME_DIR/hooks/notify.sh"]);
    expect(commandsFor(claude, "PreToolUse")).toEqual(["rtk hook claude"]);
    const cursor = read(paths.configs.cursor);
    expect(commandsFor(cursor, "stop")).toEqual(["/x/.superset/hooks/cursor-hook.sh Stop"]);
    expect(commandsFor(cursor, "afterAgentResponse")).toEqual(["/var/lib/surface/cursor"]);
    expect(fs.existsSync(paths.helper)).toBe(false);
    for (const status of hooksStatus(paths)) {
      expect(status.installed).toBe(false);
    }
  });

  it("creates configs that do not exist yet", () => {
    const dir = tmp();
    const paths: HookInstallPaths = {
      helper: path.join(dir, "bin", "sidecar-hook"),
      backups: path.join(dir, "backups"),
      configs: {
        claude: path.join(dir, "a", "settings.json"),
        codex: path.join(dir, "b", "hooks.json"),
        cursor: path.join(dir, "c", "hooks.json"),
      },
    };
    const statuses = installHooks(paths);
    expect(statuses.every((status) => status.installed)).toBe(true);
    expect(read(paths.configs.cursor).version).toBe(1);
  });

  it("reports the Codex trust step", () => {
    const paths = fixture();
    const statuses = installHooks(paths);
    const codex = statuses.find((status) => status.harness === "codex");
    expect(codex?.note).toMatch(/\/hooks/);
  });

  it("backs up an existing config before rewriting it", () => {
    const paths = fixture();
    installHooks(paths);
    const backups = fs.readdirSync(paths.backups);
    expect(backups.some((name) => name.startsWith("settings.json"))).toBe(true);
  });
});

describe("hook helper script", () => {
  it("spools an event from a real agent payload without node", () => {
    const dir = tmp();
    const paths: HookInstallPaths = {
      helper: path.join(dir, "bin", "sidecar-hook"),
      backups: path.join(dir, "backups"),
      configs: {
        claude: path.join(dir, "settings.json"),
        codex: path.join(dir, "hooks.json"),
        cursor: path.join(dir, "cursor.json"),
      },
    };
    writeHelper(paths);
    expect(fs.statSync(paths.helper).mode & 0o111).toBeGreaterThan(0);

    const payload = JSON.stringify({
      session_id: "abc123",
      cwd: "/Users/me/proj",
      transcript_path: "/tmp/t.jsonl",
      hook_event_name: "Stop",
    });
    execFileSync(paths.helper, ["claude", "Stop"], {
      input: payload,
      env: { ...process.env, SIDECAR_HOME: dir },
    });

    const batch = readSpool(path.join(dir, "hooks"));
    expect(batch.failures).toBe(0);
    expect(batch.events).toHaveLength(1);
    const event = batch.events[0]!;
    expect(event.harness).toBe("claude");
    expect(event.type).toBe("Stop");
    expect(sessionIdFromPayload("claude", event.payload)).toBe("abc123");
    expect(cwdFromPayload("claude", event.payload)).toBe("/Users/me/proj");

    clearSpool(batch.files);
    expect(readSpool(path.join(dir, "hooks")).events).toHaveLength(0);
  });

  it("orders events that land inside the same second", () => {
    const dir = tmp();
    const helper = path.join(dir, "bin", "sidecar-hook");
    writeHelper({
      helper,
      backups: path.join(dir, "backups"),
      configs: { claude: "", codex: "", cursor: "" },
    });
    const fire = (type: string): void => {
      execFileSync(helper, ["claude", type], {
        input: JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
        env: { ...process.env, SIDECAR_HOME: dir },
      });
    };
    fire("PreToolUse");
    fire("PostToolUse");
    fire("Stop");

    const batch = readSpool(path.join(dir, "hooks"));
    expect(batch.events.map((event) => event.type)).toEqual([
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);
    // All three inside one second is the case that breaks naive name sorting.
    const seconds = new Set(batch.events.map((event) => event.ts));
    expect(seconds.size).toBeLessThanOrEqual(2);
  });

  it("survives an empty stdin payload", () => {
    const dir = tmp();
    const helper = path.join(dir, "bin", "sidecar-hook");
    writeHelper({
      helper,
      backups: path.join(dir, "backups"),
      configs: { claude: "", codex: "", cursor: "" },
    });
    execFileSync(helper, ["codex", "SessionStart"], {
      input: "",
      env: { ...process.env, SIDECAR_HOME: dir },
    });
    const batch = readSpool(path.join(dir, "hooks"));
    expect(batch.failures).toBe(0);
    expect(batch.events[0]?.type).toBe("SessionStart");
    expect(batch.events[0]?.payload).toBeNull();
  });
});

describe("hook event mapping", () => {
  it("maps a finished turn to needing you, not to ended", () => {
    expect(hookOutcome("claude", "Stop")).toEqual({ state: "needs_attention", hasBlocking: false });
    expect(hookOutcome("codex", "Stop")).toEqual({ state: "needs_attention", hasBlocking: false });
    expect(hookOutcome("cursor", "stop")).toEqual({ state: "needs_attention", hasBlocking: false });
  });

  it("maps permission prompts to blocking attention", () => {
    expect(hookOutcome("claude", "PermissionRequest")?.hasBlocking).toBe(true);
    expect(hookOutcome("cursor", "beforeShellExecution")?.hasBlocking).toBe(true);
    expect(hookOutcome("cursor", "beforeMCPExecution")?.hasBlocking).toBe(true);
  });

  it("maps tool activity to working and session end to ended", () => {
    expect(hookOutcome("claude", "PostToolUse")?.state).toBe("active");
    expect(hookOutcome("claude", "SessionEnd")?.state).toBe("ended");
    expect(hookOutcome("claude", "NotAnEvent")).toBeNull();
  });

  it("reads Cursor's differently named identity fields", () => {
    const payload = { conversation_id: "conv-1", workspace_roots: ["/Users/me/repo"] };
    expect(sessionIdFromPayload("cursor", payload)).toBe("conv-1");
    expect(cwdFromPayload("cursor", payload)).toBe("/Users/me/repo");
  });
});
