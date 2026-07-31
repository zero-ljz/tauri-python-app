export const REDACTED = "[REDACTED]";

const sensitiveParts = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "api_key",
  "apikey",
  "private_key",
  "credential",
];

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return sensitiveParts.some((part) => normalized.includes(part));
}

export function redactText(value: string, maxLength?: number): string {
  const redacted = value
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(password|passwd|secret|token|authorization|api[_-]?key|credential)\s*[:=]\s*([^\s,;]+)/gi,
      (_match, key: string) => `${key}=${REDACTED}`,
    );
  if (maxLength !== undefined && redacted.length > maxLength) {
    return `${redacted.slice(0, maxLength)}… (${redacted.length} chars)`;
  }
  return redacted;
}

export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen),
    ]),
  );
}
