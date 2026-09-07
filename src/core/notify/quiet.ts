// True between from and to, in local time; a range that crosses midnight wraps.
export function inQuietHours(now: Date, from: string | null, to: string | null): boolean {
  const start = minutes(from);
  const end = minutes(to);
  if (start == null || end == null || start === end) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function minutes(value: string | null): number | null {
  const match = value ? /^(\d{2}):(\d{2})$/.exec(value) : null;
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
