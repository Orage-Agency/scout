# Redaction Audit

This document lists exactly what Scout redacts before data leaves the browser, where the redaction runs, and what is explicitly NOT covered. Use this to decide what surfaces are safe to record and what to warn users about.

## Where redaction runs

All redaction executes in the **content script** (`apps/extension/src/content/index.ts`) before events are sent to the service worker via `chrome.runtime.sendMessage`. The service worker (`background/index.ts`) never receives unredacted text from keyboard or paste events.

The redaction functions live in `apps/extension/src/lib/redaction.ts`.

## What IS redacted (client-side, before upload)

| Data type | Pattern / method | Applied to | File:line |
|-----------|-----------------|-----------|-----------|
| Credit card numbers | Regex `\b(?:\d[ -]?){13,19}\b` | Paste content, form fill values | `redaction.ts:4` |
| SSNs | Regex `\b\d{3}-\d{2}-\d{4}\b` | Paste content, form fill values | `redaction.ts:6` |
| EINs | Regex `\b\d{2}-\d{7}\b` | Paste content, form fill values | `redaction.ts:7` |
| Email addresses | Regex `/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi` | Paste content, form fill values | `redaction.ts:5` |
| US phone numbers | Regex with separators (avoids false-positives on order numbers) | Paste content, form fill values | `redaction.ts:9` |
| API keys | Common prefixes: `sk-`, `pk-`, `rk-`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `sbp_`, `xoxb`, `xoxp`, `xoxo`, `AKIA`, `AIza`, `ya29` followed by 20+ chars | Paste content, form fill values | `redaction.ts:11` |
| Long hex secrets | 40+ consecutive hex chars (SHA1/SHA256 tokens, bearer tokens) | Paste content, form fill values | `redaction.ts:13` |
| Password field keystrokes | `isPasswordField()` check: `input[type="password"]` or `autocomplete` containing "password" | Keydown events | `redaction.ts:27-34`, `content/index.ts` |
| Password field form-fill values | Same `isPasswordField()` check | Form fill (blur) events | `content/index.ts` |

### Redaction is applied to:
- `paste` event: content is passed through `redactString(truncatePaste(text))` — `content/index.ts`
- `form_fill` event (blur on text inputs): value is passed through `redactString()` — `content/index.ts`
- `keydown` on password fields: `data.key` replaced with `"[REDACTED]"` — `content/index.ts`

### Redaction is NOT applied to:
- `click` events: `visibleText` and `selector` capture element labels, not user input. These are UI element descriptors and are not redacted. If a UI element's visible text happens to contain PII (e.g., a data table cell shows an email), that text will be captured unredacted.
- `copy` events: the copied text snippet is captured as-is. Users should not copy sensitive values while recording.
- `navigation` events: full URL is captured. URLs may contain PII in query parameters (e.g., `?email=user@example.com`). URL redaction is not implemented in v1.
- `tab_switch` events: same as navigation — URL captured as-is.
- `select_change` events: the selected option text is captured as-is.
- `coach_reply` events: user's typed reply to a coach question is captured as-is (intentional — this is annotation context for the LLM).

## What is NOT redacted (known gaps — ship vs. warn decisions)

| Gap | Risk level | Recommended action |
|-----|-----------|-------------------|
| **Screenshot text (OCR)** | **High** | Screenshots capture all visible screen text including PII. No client-side OCR redaction in v1. **The PII acknowledgement modal (added in v0.2.2) discloses this at first recording.** Do not record sensitive surfaces (banking, medical, HR systems) without this being understood. |
| URL query parameters | Medium | PII in URLs (email, token, ID) is captured. Mitigation: avoid recording flows that embed PII in URLs, or strip params in future via a URL sanitizer. |
| Click target `visibleText` | Low | Captures element label text. Risk only materialises if UI renders user-submitted PII as button/link text (e.g., "Send to user@example.com"). |
| Copy events | Low | Snippet is limited to 200 chars. Users are unlikely to copy raw secrets during a workflow recording, but not prevented. |
| Non-password autocomplete fields | Low | Fields with `autocomplete="cc-number"` but `type="text"` are not caught by `isPasswordField()`. CC pattern regex catches the value anyway, but only for common formats. |

## Redaction order

`redactString()` applies patterns in this order (first match wins per occurrence):
1. CC
2. SSN
3. EIN
4. EMAIL
5. PHONE
6. API_KEY
7. HEX_SECRET

Note: patterns are applied sequentially via chained `.replace()` calls — all matches of each pattern are replaced before moving to the next.

## Testing redaction

```ts
// Quick manual test in browser DevTools console on any page with the extension loaded:
// (Copy redaction.ts patterns to console and call redactString directly)
import { redactString } from "chrome-extension://<id>/assets/content.js"; // won't work directly
// Better: add unit tests in apps/extension/src/lib/redaction.test.ts
```

Unit tests for redaction patterns are a recommended addition before shipping to non-Orage users.
