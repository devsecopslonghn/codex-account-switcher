const secrets = new Set<string>();
export function rememberSecret(value: string): void {
  if (value) secrets.add(value);
}
export function safeOutput(value: unknown): string {
  let result = JSON.stringify(value, null, 2);
  for (const secret of secrets)
    result = result.split(secret).join("[REDACTED]");
  return result
    .replace(
      /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
      "[REDACTED_JWT]",
    )
    .replace(/(?:oma_|sk-|rt_)[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
