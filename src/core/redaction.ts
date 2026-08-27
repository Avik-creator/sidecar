const SECRET = /(sk-[a-zA-Z0-9]{12,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;
const BEARER = /bearer\s+[a-z0-9._\-+/=]{12,}/gi;

export function redact(text: string): string {
  return text.replace(SECRET, "[redacted]").replace(BEARER, "bearer [redacted]");
}

export function boundedContext(text: string, max = 2_000): string {
  const cleaned = redact(text).trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max)}\n…`;
}
