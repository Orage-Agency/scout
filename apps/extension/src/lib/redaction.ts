// Heuristic PII redaction. Applied client-side before any data leaves the browser.
// Better to lose signal than to leak. Per §15.2.

const CC = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN = /\b\d{2}-\d{7}\b/g;

export function redactString(input: string): string {
  if (!input) return input;
  return input
    .replace(CC, "[CC_REDACTED]")
    .replace(SSN, "[SSN_REDACTED]")
    .replace(EIN, "[EIN_REDACTED]")
    .replace(EMAIL, "[EMAIL_REDACTED]");
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
