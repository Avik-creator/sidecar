import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARK_ACCENT, markSvgDocument, markSvgInner } from "../src/shared/mark.js";
import { appIconPng } from "../src/main/raster.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function write(rel: string, contents: string | Buffer): void {
  const filePath = path.join(root, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  console.log(rel);
}

write("docs/brand/mark.svg", `${markSvgDocument(MARK_ACCENT)}\n`);
write("src/renderer/public/mark.svg", `${markSvgDocument(MARK_ACCENT)}\n`);
write("build/icon.png", appIconPng(512));
write("docs/brand/icon.png", appIconPng(512));
write("docs/brand/panel.svg", panelSvg());

function panelSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 700" width="400" height="700" role="img" aria-label="Sidecar menu bar panel">
  <rect width="400" height="700" rx="18" fill="#f4efe6"/>
  <rect x="16" y="14" width="368" height="36" fill="none"/>
  <text x="200" y="38" text-anchor="middle" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="17" font-weight="700" fill="#1a1612">Sidecar</text>
  ${markAt(248, 28, 12, "#d56a2d")}
  <rect x="12" y="58" width="376" height="52" rx="14" fill="#efe8dc"/>
  ${tab(30, 68, "Agents", true)}
  ${tab(124, 68, "Setup", false)}
  ${tab(218, 68, "Usage", false)}
  ${tab(312, 68, "Improve", false)}
  <text x="20" y="138" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="10" font-weight="700" letter-spacing="1.4" fill="#8a8174">NEEDS YOU</text>
  ${card(16, 150, "Claude Code", "sidecar", "waiting", "Allow edit to app.css", "#c4652a")}
  <text x="20" y="268" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="10" font-weight="700" letter-spacing="1.4" fill="#8a8174">RUNNING</text>
  ${card(16, 280, "Codex", "sidecar", "working", "Wire live usage windows", "#1c1c1c")}
  ${card(16, 384, "Cursor", "sidecar", "working", "Keep Improve fully local", "#4f46c8")}
  <rect x="0" y="652" width="400" height="48" fill="#efe8dc"/>
  <text x="24" y="681" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="11" fill="#1a1612">Claude Code</text>
  <text x="132" y="681" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="11" fill="#1a1612">Codex</text>
  <text x="214" y="681" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="11" fill="#1a1612">Cursor</text>
</svg>
`;
}

function markAt(x: number, y: number, size: number, fill: string): string {
  const scale = size / 24;
  return `<g transform="translate(${x - size / 2} ${y - size / 2}) scale(${scale})">${markSvgInner(fill)}</g>`;
}

function tab(x: number, y: number, label: string, active: boolean): string {
  const fill = active ? "#fffaf3" : "transparent";
  const color = active ? "#1a1612" : "#8a8174";
  return `<g>
    <rect x="${x}" y="${y}" width="84" height="32" rx="10" fill="${fill}"/>
    <text x="${x + 42}" y="${y + 21}" text-anchor="middle" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="11" font-weight="600" fill="${color}">${label}</text>
  </g>`;
}

function card(
  x: number,
  y: number,
  harness: string,
  repo: string,
  status: string,
  title: string,
  color: string,
): string {
  return `<g>
    <rect x="${x}" y="${y}" width="368" height="92" rx="16" fill="#fffaf3" stroke="#e7dfd2"/>
    <circle cx="${x + 22}" cy="${y + 24}" r="5" fill="${color}"/>
    <text x="${x + 34}" y="${y + 28}" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="11" font-weight="600" fill="${color}">${harness}</text>
    <text x="${x + 348}" y="${y + 28}" text-anchor="end" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="11" fill="#8a8174">now</text>
    <text x="${x + 18}" y="${y + 54}" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="14" font-weight="600" fill="#1a1612">${title}</text>
    <text x="${x + 18}" y="${y + 76}" font-family="Avenir Next, SF Pro Text, sans-serif" font-size="11" fill="#8a8174">${repo} · ${status}</text>
  </g>`;
}
