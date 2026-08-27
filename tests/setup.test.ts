import { describe, expect, it } from "vitest";
import {
  findMcpServers,
  parseSetupConfig,
  parseSkillMetadata,
} from "../src/core/setup/index.js";

describe("setup indexing", () => {
  it("uses YAML skill frontmatter for the displayed name and description", () => {
    const metadata = parseSkillMetadata(
      `---
name: release-notes
description: >-
  Draft release notes from commits
  and pull requests.
---
# Instructions
`,
      "fallback",
    );

    expect(metadata.name).toBe("release-notes");
    expect(metadata.description).toBe("Draft release notes from commits and pull requests.");
  });

  it("parses JSONC and TOML MCP server sections", () => {
    const json = parseSetupConfig(
      "/tmp/mcp.jsonc",
      `{
        // Shared editor servers
        "mcpServers": {
          "linear": { "url": "https://mcp.linear.app" }
        }
      }`,
    );
    const toml = parseSetupConfig(
      "/tmp/config.toml",
      `[mcp_servers.goland]
url = "http://127.0.0.1:64342"
`,
    );

    expect(findMcpServers(json, new Set(["mcpServers"])).map(([name]) => name)).toEqual(["linear"]);
    expect(findMcpServers(toml, new Set(["mcp_servers"])).map(([name]) => name)).toEqual(["goland"]);
  });

  it("parses YAML extension-based MCP configurations", () => {
    const yaml = parseSetupConfig(
      "/tmp/config.yaml",
      `extensions:
  github:
    type: stdio
    command: npx
`,
    );

    expect(findMcpServers(yaml, new Set(["extensions"])).map(([name]) => name)).toEqual(["github"]);
  });
});
