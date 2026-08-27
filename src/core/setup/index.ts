import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { SetupItemRecord, SetupKind, SetupSource } from "../../shared/types.js";
import { shortHash } from "../hash.js";
import { claudeRoot, codexRoot, cursorHome } from "../paths.js";
import { firstLine } from "../text.js";
import type { Store } from "../db/store.js";

export function indexSetup(store: Store): SetupItemRecord[] {
  const items = collectSetup(store);
  store.replaceSetupItems(items);
  return items;
}

export function collectSetup(store: Store): SetupItemRecord[] {
  const items: SetupItemRecord[] = [
    ...scanClaude(),
    ...scanCodex(),
    ...scanCursor(),
    ...scanAdditionalSkills(),
    ...scanProjectSkills(store),
    ...scanMcpConfigs(store),
  ];
  return items;
}

function scanClaude(): SetupItemRecord[] {
  const root = claudeRoot();
  const items: SetupItemRecord[] = [];
  pushFile(items, "claude", "rule", path.join(root, "CLAUDE.md"), "global");
  pushFile(items, "claude", "hook", path.join(root, "settings.json"), "global");
  pushSkills(items, "claude", path.join(root, "skills"), "global");
  pushDir(items, "claude", "agent", path.join(root, "agents"), "global");
  pushDir(items, "claude", "plugin", path.join(root, "plugins"), "global", 1);
  return items;
}

function scanCodex(): SetupItemRecord[] {
  const root = codexRoot();
  const items: SetupItemRecord[] = [];
  pushFile(items, "codex", "rule", path.join(root, "config.toml"), "global");
  pushFile(items, "codex", "hook", path.join(root, "hooks.json"), "global");
  pushSkills(items, "codex", path.join(root, "skills"), "global");
  pushDir(items, "codex", "agent", path.join(root, "agents"), "global");
  return items;
}

function scanCursor(): SetupItemRecord[] {
  const root = cursorHome();
  const items: SetupItemRecord[] = [];
  pushFile(items, "cursor", "hook", path.join(root, "hooks.json"), "global");
  pushSkills(items, "cursor", path.join(root, "skills"), "global");
  pushSkills(items, "cursor", path.join(root, "skills-cursor"), "global");
  pushDir(items, "cursor", "agent", path.join(root, "agents"), "global");
  pushDir(items, "cursor", "plugin", path.join(root, "plugins"), "global", 1);
  pushDir(items, "cursor", "plan", path.join(root, "plans"), "global");
  return items;
}

function scanAdditionalSkills(): SetupItemRecord[] {
  const home = os.homedir();
  const items: SetupItemRecord[] = [];
  pushSkills(items, "universal", path.join(home, ".agents", "skills"), "global");
  pushSkills(items, "gemini-cli", path.join(home, ".gemini", "skills"), "global");
  pushSkills(items, "antigravity", path.join(home, ".gemini", "antigravity", "skills"), "global");
  return items;
}

function scanProjectSkills(store: Store): SetupItemRecord[] {
  const items: SetupItemRecord[] = [];
  const directories: Array<[SetupSource, string]> = [
    ["universal", ".agents/skills"],
    ["claude", ".claude/skills"],
    ["cline", ".cline/skills"],
    ["codex", ".codex/skills"],
    ["cursor", ".cursor/skills"],
    ["gemini-cli", ".gemini/skills"],
    ["goose", ".goose/skills"],
    ["github-copilot-cli", ".github/skills"],
    ["grok-build", ".grok/skills"],
    ["kilo-code", ".kilocode/skills"],
    ["kimi-code", ".kimi-code/skills"],
    ["kiro-cli", ".kiro/skills"],
    ["opencode", ".opencode/skills"],
    ["windsurf", ".windsurf/skills"],
  ];
  for (const root of setupProjectRoots(store)) {
    for (const [source, relativePath] of directories) {
      pushSkills(items, source, path.join(root, relativePath), "repo");
    }
  }
  return items;
}

function pushFile(
  items: SetupItemRecord[],
  harness: SetupSource,
  kind: SetupKind,
  filePath: string,
  scope: "global" | "repo",
): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return;
  }
  const stat = fs.statSync(filePath);
  const preview = safePreview(filePath);
  items.push({
    id: shortHash(`${harness}:${kind}:${filePath}`),
    harness,
    kind,
    path: filePath,
    title: path.basename(filePath),
    scope,
    mtimeMs: Math.trunc(stat.mtimeMs),
    hash: shortHash(preview),
    preview,
  });
}

function pushDir(
  items: SetupItemRecord[],
  harness: SetupSource,
  kind: SetupKind,
  dir: string,
  scope: "global" | "repo",
  depth = 2,
): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  walk(dir, depth, (filePath) => {
    const base = path.basename(filePath);
    if (base.startsWith(".")) {
      return;
    }
    if (!/\.(md|json|toml|txt|js|ts|mjs|cjs)$/i.test(base) && kind !== "plugin") {
      if (base !== "SKILL.md" && base !== "HOOKS.md") {
        return;
      }
    }
    pushFile(items, harness, kind, filePath, scope);
  });
}

function pushSkills(
  items: SetupItemRecord[],
  harness: SetupSource,
  dir: string,
  scope: "global" | "repo",
): void {
  walkSkillDirs(dir, 0, 5, (skillPath) => {
    const stat = safeStat(skillPath);
    if (!stat) {
      return;
    }
    const metadata = readSkillMetadata(skillPath);
    items.push({
      id: shortHash(`${harness}:skill:${skillPath}`),
      harness,
      kind: "skill",
      path: skillPath,
      title: metadata.name,
      scope,
      mtimeMs: Math.trunc(stat.mtimeMs),
      hash: shortHash(metadata.raw),
      preview: metadata.description,
    });
  });
}

function walkSkillDirs(
  dir: string,
  depth: number,
  maxDepth: number,
  visit: (skillPath: string) => void,
): void {
  if (depth > maxDepth) {
    return;
  }
  const skillPath = path.join(dir, "SKILL.md");
  if (safeStat(skillPath)?.isFile()) {
    visit(skillPath);
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "cache") {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (safeStat(child)?.isDirectory()) {
      walkSkillDirs(child, depth + 1, maxDepth, visit);
    }
  }
}

function readSkillMetadata(skillPath: string): { name: string; description: string; raw: string } {
  let raw = "";
  try {
    raw = fs.readFileSync(skillPath, "utf8");
  } catch {
    return { name: path.basename(path.dirname(skillPath)), description: "", raw };
  }
  return parseSkillMetadata(raw, path.basename(path.dirname(skillPath)));
}

export function parseSkillMetadata(
  raw: string,
  fallbackName: string,
): { name: string; description: string; raw: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    return { name: fallbackName, description: markdownSummary(raw), raw };
  }
  try {
    const frontmatter = parseYaml(match[1]) as unknown;
    if (!isRecord(frontmatter)) {
      return { name: fallbackName, description: markdownSummary(raw.slice(match[0].length)), raw };
    }
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : fallbackName;
    const description =
      typeof frontmatter.description === "string"
        ? frontmatter.description.trim().replace(/\s+/g, " ").slice(0, 240)
        : markdownSummary(raw.slice(match[0].length));
    return { name: name || fallbackName, description, raw };
  } catch {
    return { name: fallbackName, description: markdownSummary(raw.slice(match[0].length)), raw };
  }
}

function markdownSummary(markdown: string): string {
  const line = markdown
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return (line ?? "").replace(/^#+\s*/, "").slice(0, 240);
}

interface McpConfigLocation {
  source: SetupSource;
  globalPaths: string[];
  projectPaths: string[];
  sectionKeys: string[];
}

function scanMcpConfigs(store: Store): SetupItemRecord[] {
  const home = os.homedir();
  const applicationSupport = path.join(home, "Library", "Application Support");
  const grokHome = process.env.GROK_HOME?.trim() || path.join(home, ".grok");
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code");
  const locations: McpConfigLocation[] = [
    location("antigravity", [path.join(home, ".gemini/config/mcp_config.json")]),
    location("cline", [path.join(applicationSupport, "Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json")]),
    location("cline-cli", [path.join(home, ".cline/data/settings/cline_mcp_settings.json")]),
    location("claude", [path.join(home, ".claude.json")], [".mcp.json"]),
    location("claude-desktop", [path.join(applicationSupport, "Claude/claude_desktop_config.json")]),
    location("codex", [path.join(home, ".codex/config.toml")], [".codex/config.toml"], ["mcp_servers"]),
    location("cursor", [path.join(home, ".cursor/mcp.json")], [".cursor/mcp.json"]),
    location("fx", [path.join(home, ".fx/mcp.json")]),
    location("gemini-cli", [path.join(home, ".gemini/settings.json")], [".gemini/settings.json"]),
    location("goose", [path.join(home, ".config/goose/config.yaml")], [".goose/config.yaml"], ["extensions"]),
    location("github-copilot-cli", [path.join(home, ".copilot/mcp-config.json")], [".vscode/mcp.json"], ["servers"]),
    location("grok-build", [path.join(grokHome, "config.toml")], [".grok/config.toml"], ["mcp_servers"]),
    location(
      "kilo-code",
      [path.join(home, ".config/kilo/kilo.json"), path.join(home, ".config/kilo/kilo.jsonc")],
      ["kilo.json", "kilo.jsonc", ".kilo/kilo.json", ".kilocode/kilo.json"],
    ),
    location("kimi-code", [path.join(kimiHome, "mcp.json")], [".kimi-code/mcp.json"]),
    location("kiro-cli", [path.join(home, ".kiro/settings/mcp.json")], [".kiro/settings/mcp.json"]),
    location(
      "mcporter",
      [path.join(home, ".mcporter/mcporter.json"), path.join(home, ".mcporter/mcporter.jsonc")],
      ["config/mcporter.json"],
    ),
    location(
      "opencode",
      [path.join(home, ".config/opencode/opencode.jsonc"), path.join(home, ".config/opencode/opencode.json")],
      ["opencode.jsonc", "opencode.json", ".opencode/opencode.jsonc"],
      ["mcp"],
    ),
    location("vscode", [path.join(applicationSupport, "Code/User/mcp.json")], [".vscode/mcp.json"], ["servers"]),
    location("windsurf", [path.join(home, ".codeium/windsurf/mcp_config.json")]),
    location("zed", [path.join(applicationSupport, "Zed/settings.json")], [".zed/settings.json"], ["context_servers"]),
  ];

  const projectRoots = setupProjectRoots(store);
  const items: SetupItemRecord[] = [];
  const seen = new Set<string>();
  for (const config of locations) {
    for (const filePath of config.globalPaths) {
      pushMcpFile(items, seen, config, filePath, "global");
    }
    for (const root of projectRoots) {
      for (const relativePath of config.projectPaths) {
        pushMcpFile(items, seen, config, path.join(root, relativePath), "repo");
      }
    }
  }
  return items;
}

function location(
  source: SetupSource,
  globalPaths: string[],
  projectPaths: string[] = [],
  sectionKeys: string[] = ["mcpServers", "mcp_servers"],
): McpConfigLocation {
  return { source, globalPaths, projectPaths, sectionKeys };
}

function setupProjectRoots(store: Store): string[] {
  const roots = new Set<string>();
  const home = os.homedir();
  for (const session of store.listSessions()) {
    let current = session.cwd;
    for (let depth = 0; current && current !== home && depth < 6; depth += 1) {
      roots.add(current);
      if (fs.existsSync(path.join(current, ".git"))) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return [...roots];
}

function pushMcpFile(
  items: SetupItemRecord[],
  seen: Set<string>,
  config: McpConfigLocation,
  filePath: string,
  scope: "global" | "repo",
): void {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) {
    return;
  }
  let raw: string;
  let parsed: unknown;
  try {
    raw = fs.readFileSync(filePath, "utf8");
    parsed = parseSetupConfig(filePath, raw);
  } catch {
    return;
  }
  for (const [name, definition] of findMcpServers(parsed, new Set(config.sectionKeys))) {
    const key = `${filePath}:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({
      id: shortHash(`mcp:${config.source}:${key}`),
      harness: config.source,
      kind: "mcp",
      path: `${filePath}#${encodeURIComponent(name)}`,
      title: name,
      scope,
      mtimeMs: Math.trunc(stat.mtimeMs),
      hash: shortHash(JSON.stringify(definition)),
      preview: describeMcpServer(definition),
    });
  }
}

export function parseSetupConfig(filePath: string, raw: string): unknown {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".toml") {
    return parseToml(raw);
  }
  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(raw);
  }
  return parseJsonc(raw);
}

export function findMcpServers(value: unknown, sectionKeys: Set<string>, depth = 0): Array<[string, unknown]> {
  if (!isRecord(value) || depth > 6) {
    return [];
  }
  const servers: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (sectionKeys.has(key)) {
      if (Array.isArray(child)) {
        for (const entry of child) {
          if (isRecord(entry) && typeof entry.name === "string") {
            servers.push([entry.name, entry]);
          }
        }
      } else if (isRecord(child)) {
        servers.push(...Object.entries(child));
      }
      continue;
    }
    if (isRecord(child)) {
      servers.push(...findMcpServers(child, sectionKeys, depth + 1));
    }
  }
  return servers;
}

function describeMcpServer(value: unknown): string {
  if (!isRecord(value)) {
    return "Configured";
  }
  const enabled = value.enabled !== false && value.disabled !== true;
  const commandValue = Array.isArray(value.command) ? value.command[0] : value.command;
  const command = typeof commandValue === "string" ? path.basename(commandValue) : null;
  const url = firstString(value.url, value.httpUrl, value.serverUrl);
  const configuredType = firstString(value.type, value.transport);
  const transport = command ? "stdio" : configuredType ?? (url ? "http" : "configured");
  const target = command ?? safeHostname(url);
  return `${enabled ? "" : "Disabled · "}${transport}${target ? ` · ${target}` : ""}`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function safeHostname(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function walk(dir: string, depth: number, visit: (filePath: string) => void): void {
  if (depth < 0) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "cache" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth - 1, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}

function safePreview(filePath: string): string {
  try {
    const text = fs.readFileSync(filePath, "utf8").slice(0, 400);
    return firstLine(text) || text.slice(0, 120);
  } catch {
    return "";
  }
}
