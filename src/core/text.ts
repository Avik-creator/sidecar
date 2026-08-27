const MAX_TURN_CHARS = 12_000;

export function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }
    const rec = part as Record<string, unknown>;
    const type = rec.type;
    if (type === "tool_result" || type === "tool_use" || type === "function_call") {
      continue;
    }
    if (typeof rec.text === "string") {
      parts.push(rec.text);
    } else if (typeof rec.content === "string") {
      parts.push(rec.content);
    }
  }
  return parts.join("\n");
}

export function truncateText(text: string, max = MAX_TURN_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n…`;
}

export function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

export function normalizeKey(text: string): string {
  return stripCodeFences(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function significantTokens(text: string, n = 8): string[] {
  const stop = new Set([
    "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with",
    "this", "that", "it", "is", "be", "please", "can", "you", "i", "we",
    "just", "now", "here",
  ]);
  return normalizeKey(text)
    .split(" ")
    .filter((tok) => tok.length > 1 && !stop.has(tok))
    .slice(0, n);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function asBool(value: unknown): boolean {
  return value === true || value === 1;
}
