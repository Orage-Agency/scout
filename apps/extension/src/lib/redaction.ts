// Heuristic PII redaction. Applied client-side before any data leaves the browser.
// Better to lose signal than to leak. Per §15.2.

const CC = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN = /\b\d{2}-\d{7}\b/g;
// Conservative US phone: must have clear separators to avoid false-positives on order numbers.
const PHONE = /\b(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
// Common API key prefixes followed by 20+ alphanumeric chars.
const API_KEY = /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|sbp|xoxb|xoxp|xoxo|AKIA|AIza|ya29)[-_][A-Za-z0-9_-]{20,}/g;
// Long bare secrets: 40+ hex chars (SHA1/SHA256 tokens, bearer tokens).
const HEX_SECRET = /\b[0-9a-f]{40,}\b/gi;

export function redactString(input: string): string {
  if (!input) return input;
  return input
    .replace(CC, "[CC_REDACTED]")
    .replace(SSN, "[SSN_REDACTED]")
    .replace(EIN, "[EIN_REDACTED]")
    .replace(EMAIL, "[EMAIL_REDACTED]")
    .replace(PHONE, "[PHONE_REDACTED]")
    .replace(API_KEY, "[API_KEY_REDACTED]")
    .replace(HEX_SECRET, "[SECRET_REDACTED]");
}

export function isPasswordField(el: Element | null): boolean {
  if (!el) return false;
  const t = (el as HTMLInputElement).type?.toLowerCase?.();
  if (t === "password") return true;
  const auto = el.getAttribute?.("autocomplete")?.toLowerCase() ?? "";
  if (auto.includes("password")) return true;
  return false;
}

export function truncatePaste(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
}
