// Tiny ID helpers. Avoids pulling in `uuid`.

export function uuid(): string {
  // crypto.randomUUID is available in MV3 service workers and modern browsers.
  return crypto.randomUUID();
}

export function shortId(): string {
  // 12-char base36, monotonic-ish.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}${r}`;
}
