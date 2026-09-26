# Icon & Font Finder — Plan

**Priority tier:** 2 · **Bundle ID:** `com.xorro.icon-finder`

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
- [ ] `icon <query>` search Iconify API, filter by set with `set:lucide`
- [ ] `logo <brand>` search svgl.app logos (light/dark variants)
- [ ] Actions: copy SVG, copy JSX, copy data URI, save PNG, open in browser
- [ ] `font <name>` Google Fonts: preview, copy CSS @import/<link>, download family

## Tech
- **Stack:** zsh + JXA; icon previews rendered to cached PNGs for Alfred icons.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
