#!/usr/bin/env node
import fs from "node:fs";
import { appendHook } from "../core/hooks/append.js";
import { SidecarService } from "../core/app.js";
import { dbPath } from "../core/paths.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "ingest":
      await withService(async (svc) => {
        const report = await svc.ingest();
        console.log(JSON.stringify(report, null, 2));
      });
      return;
    case "usage":
      await withService(async (svc) => {
        const days = numberFlag(rest, "--days") ?? 30;
        console.log(JSON.stringify(await svc.usage(days), null, 2));
      });
      return;
    case "agents":
      await withService(async (svc) => {
        console.log(JSON.stringify(await svc.sessions(), null, 2));
      });
      return;
    case "setup":
      await withService(async (svc) => {
        await svc.ingest();
        console.log(JSON.stringify(await svc.setup(), null, 2));
      });
      return;
    case "candidates":
      await withService(async (svc) => {
        console.log(JSON.stringify(await svc.candidates(numberFlag(rest, "--limit") ?? 50), null, 2));
      });
      return;
    case "improve":
      await withService(async (svc) => {
        const report = await svc.runImprove();
        console.log(JSON.stringify({ report, suggestions: await svc.suggestions() }, null, 2));
      });
      return;
    case "apply":
      await withService(async (svc) => {
        const id = rest[0];
        if (!id) {
          throw new Error("usage: sidecar apply <suggestion-id>");
        }
        console.log(JSON.stringify(await svc.applySuggestion(id), null, 2));
      });
      return;
    case "undo":
      await withService(async (svc) => {
        const id = rest[0];
        if (!id) {
          throw new Error("usage: sidecar undo <suggestion-id>");
        }
        console.log(JSON.stringify(await svc.undoSuggestion(id), null, 2));
      });
      return;
    case "dismiss":
      await withService(async (svc) => {
        const id = rest[0];
        if (!id) {
          throw new Error("usage: sidecar dismiss <suggestion-id>");
        }
        await svc.dismissSuggestion(id);
        console.log(JSON.stringify({ ok: true, id }));
      });
      return;
    case "health":
      await withService(async (svc) => {
        console.log(JSON.stringify(await svc.health(), null, 2));
      });
      return;
    case "hook": {
      const harness = (flag(rest, "--harness") ?? "claude") as "claude" | "codex" | "cursor";
      const type = flag(rest, "--type") ?? "unknown";
      const sessionId = flag(rest, "--session") ?? undefined;
      const payload = readStdinJson();
      appendHook({ harness, type, sessionId, payload });
      return;
    }
    default:
      console.log(`Sidecar — local-first companion for coding agents

Usage:
  sidecar ingest
  sidecar usage [--days 30]
  sidecar agents
  sidecar setup
  sidecar candidates [--limit 50]
  sidecar improve
  sidecar apply <id>
  sidecar undo <id>
  sidecar dismiss <id>
  sidecar health
  sidecar hook --harness claude --type PermissionRequest [--session <id>]

DB: ${dbPath()}
`);
  }
}

async function withService(fn: (svc: SidecarService) => Promise<void>): Promise<void> {
  const svc = SidecarService.open();
  try {
    await fn(svc);
  } finally {
    svc.close();
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function numberFlag(args: string[], name: string): number | undefined {
  const value = flag(args, name);
  if (!value) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readStdinJson(): unknown {
  if (process.stdin.isTTY) {
    return {};
  }
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
