# Icon & Font Finder — Plan

**Priority tier:** 2 · **Bundle ID:** `io.github.x-o-r-r-o.icon-finder` · **Keywords:** `icon`, `logo`, `font`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Svgl | 42,193 |
| Google Fonts | 29,796 |
| Iconify | 28,689 |
| Lucide Icons | 8,960 |
| Material Icons | 5,538 |
| Simple Icons | 4,756 |
| Heroicons | 4,542 |
| **Total** | **124,474** |

**Alfred today:** Font Awesome workflow (old), SF Symbols covered; no Iconify/SVGL/Google Fonts.

## Features (v1.0)
- [x] `icon <query>` search Iconify API, filter by set with `set:lucide` / `@lucide`, `@` lists sets, preferred sets
- [x] Rendered PNG previews (NSImage SVG, Quick Look fallback), fetched in parallel in the background, Script Filter rerun
- [x] `logo <brand>` search svgl.app logos (light/dark variants, wordmarks) + Simple Icons / SVG Logos fallback
- [x] Actions: copy/paste SVG, copy JSX, copy name, copy data URI, save PNG, open in browser, Quick Look
- [x] `font <name>` Google Fonts: category filters, copy `<link>`, `@import`, `font-family`, next/font, stylesheet URL
- [ ] ~~Download family~~ (Google Fonts no longer offers a zip download endpoint; the specimen page has the button)
- [x] Offline: cached searches, lists and SVGs; back-off after network failures and HTTP 429
- [x] Tests: fixtures + mock server, rasterising, JSX, prune; `IF_LIVE=1` smoke test

## Tech
- **Stack:** bash + JXA (ObjC bridge: NSImage/CoreSVG rasterising, NSTask + `/usr/bin/curl --parallel`); icon previews rendered to cached PNGs for Alfred icons.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. [x] Script filter prototype for the main keyword
2. [x] Actions + modifiers, Universal Actions / File Actions where relevant
3. [x] Workflow Configuration, icons, error states (no network / missing dependency)
4. [ ] README with screenshots, `python3 tools/build.py --package` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] Any compiled binary is Developer ID signed + notarised; never strip quarantine (none shipped)
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README and the forum post
- [ ] Version bumped in `src/info.plist`; `python3 tools/build.py --package`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
