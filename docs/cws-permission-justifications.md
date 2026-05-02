# Chrome Web Store — Permission Justifications

The Web Store review form asks for a one-line reason per declared permission.
Paste these into the corresponding fields.

| Permission | Justification |
| --- | --- |
| `activeTab` | Capture screenshots and inject the in-page control bar in the tab the user is recording. |
| `tabs` | Detect tab switches during a recording so the captured workflow includes context navigation. |
| `scripting` | Inject the in-page control bar so the user can stop/pause without opening the popup. |
| `storage` | Persist the auth session and the in-progress recording state across service-worker restarts. |
| `offscreen` | Host the `MediaRecorder` for audio narration — service workers can't access `navigator.mediaDevices` directly. |
| `desktopCapture` | Reserved for future tab-audio capture in v0.2; currently unused. (Remove from manifest if reviewer flags this.) |
| `clipboardRead` | Read pasted content during a recording so the SKILL.md captures values the user pasted from elsewhere. |
| `webNavigation` | Record URL navigations so the SKILL.md can describe page flow accurately. |
| `<all_urls>` host permission | The user can record on any site, so screenshot capture and content-script injection must work everywhere. |

## Single purpose

The single purpose of this extension is: **capture the user's workflow on a
website and turn it into a structured `SKILL.md` document that an AI agent
can later execute.**

## Are remote scripts used?

No. All extension code is bundled into the package. The extension talks to a
fixed Supabase backend over HTTPS for storage and to OpenRouter (via the
backend) for skill generation.
