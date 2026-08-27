export interface HttpResponse {
  status: number;
  bodyText: string;
  headers: Record<string, string>;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  bodyText?: string;
  timeoutMs?: number;
}

export async function requestJson(input: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.bodyText,
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      bodyText: await response.text(),
      headers,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function parseRetryAfterMs(headers: Record<string, string>, nowMs = Date.now()): number | null {
  const raw = headers["retry-after"];
  if (!raw) {
    return null;
  }
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return null;
}

export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
