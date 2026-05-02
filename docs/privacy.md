---
title: Scout Privacy Policy
permalink: /privacy/
---

_Last updated: 2026-05-02_

Scout is a Chrome extension that records workflows you perform in your browser
and turns them into structured `SKILL.md` files that an AI agent can later
execute. This policy describes what data Scout collects, where it goes, and
what control you have over it.

## What Scout records

Scout only records when you explicitly start a recording from the popup. While
recording is active, it captures:

- **DOM events** in the active tab: clicks, key presses, paste, copy, scroll,
  and focus changes.
- **Microphone audio**, only if you grant mic permission. Used so you can
  narrate the workflow.
- **Screenshots** of the visible tab at moments of significant events (clicks,
  navigation). Routine keystrokes do not trigger screenshots.
- **Tab navigation events**: which URL you opened, when you switched tabs.
- The text of pasted content, redacted to remove anything that looks like a
  password, credit-card number, social-security number, EIN, or email.
- Key presses, redacted on password-type input fields (`input[type="password"]`)
  to `[REDACTED]`.

Scout does **not** record:

- Anything before you press Record or after you press Stop.
- Anything when the extension is paused.
- Background tabs you are not interacting with at the moment of an event.
- Any tab whose URL begins with `chrome://`, `edge://`, the new-tab page, or
  the Chrome Web Store.

## Where the data goes

When you sign in with your email, Scout creates an account on a Supabase
project owned by the developer (Orage Agency). All recordings, events,
screenshots, audio files, and generated skills are stored under your user
account in that project. They are protected by row-level security so only
your account can read them.

Scout calls the developer's Supabase Edge Functions, which in turn call the
[OpenRouter](https://openrouter.ai) API to:

- Optionally ask short clarifying questions during a recording (the "coach"
  loop).
- Transcribe your audio narration into text.
- Generate the `SKILL.md` document from your events, transcript, and a
  sample of the captured screenshots.

OpenRouter and its underlying model providers (Anthropic, Google, etc.) see
the events, transcript, and screenshots that are sent for these calls. They
do not see your Supabase credentials.

Scout does not use third-party advertising or analytics SDKs.

## What you control

- **Sign out** from the Settings tab to stop sending data to Scout's backend.
- **Delete all data** from the Settings tab to permanently remove every
  recording, event, screenshot, audio file, and skill associated with your
  account. This action cannot be undone.
- **Pause** during a recording to stop capture without ending the session.
- **Don't grant microphone permission** if you don't want audio captured;
  recording continues with events and screenshots only.

## Contact

Questions or data-access requests: `team@orage.agency`.

## Changes

We will update the "Last updated" date at the top of this document when the
policy changes. Material changes will also be announced in the extension
release notes.
