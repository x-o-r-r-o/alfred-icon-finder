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
- [x] Copy names as `mdi:home`, `i-mdi-home`, `<Icon icon=… />` or `MdiHome`; optional colour for copied SVG/JSX/data URIs (audit 4, from Raycast Iconify requests)
- [x] SVGs sanitized before storing, rendering or copying; one background worker (mkdir lock + watchdog); requests throttled across processes (audit 4)
- [x] `font <name>` Google Fonts: category filters, copy `<link>`, `@import`, `font-family`, next/font, stylesheet URL
- [ ] ~~Download family~~ (Google Fonts no longer offers a zip download endpoint; the specimen page has the button)
- [x] Offline: cached searches, lists and SVGs; back-off after network failures and HTTP 429
- [x] Tests: fixtures + mock server, rasterising, JSX, prune; `IF_LIVE=1` smoke test
- [x] Final review: the detached watchdog takes the worker/refresh lock itself (a Script Filter killed mid-spawn no longer stalls previews for 3 minutes); damaged or older-format cache files count as missing; test mode can't reach the real services or ~/Downloads
- [x] Round 4 (real-world conditions): previews on macOS 13 (`_NSSVGImageRep` tried directly when NSImage doesn't read SVG data; the Quick Look fallback no longer draws opaque white squares with the icon in a corner); ⌘⇧↩ copies the SVG's URL; recently copied icons and logos before you type; ⇧↩ can copy the PNG image instead of saving it

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

## Known limitations
- svgl locks an IP out for 3 minutes after more than 5 API requests in 10 seconds. The workflow stays at 3 per 10 seconds across processes and backs off after HTTP 429, but other svgl clients on the same network count too.
- Iconify publishes no rate limit; searches are capped at 15 per 10 seconds, and preview downloads are batched per icon set.
- Previews use AppKit's SVG renderer (CoreSVG), which doesn't support every SVG feature; a preview may differ from the copied SVG, which is untouched apart from sanitizing.
- A worker or refresh that crashes without the watchdog noticing (e.g. the watchdog itself killed) leaves its lock for at most 3 minutes (1.5 for refreshes), after which it counts as stale.
- Google Fonts has no documented metadata API; the workflow reads `fonts.google.com/metadata/fonts` (cached for 7 days, stale copy used offline).

## Alfred runtime (round 4)
- Script Filters use `queuemode` 2 (terminate the previous run), like Alfred's own network Script Filters (google-drive, google-suggest). Cache files are written atomically (write + rename); the per-URL fetch lock records its owner's pid, so a run Alfred kills mid-request no longer makes the next keystroke wait up to 32 s (fonts) for its lock to expire; the worker/refresh locks belong to the detached watchdog. A killed run's curl finishes on its own `--max-time` and leaves only a `.part` file that pruning removes.

## macOS 13 compatibility (round 4)
- JavaScript: nothing newer than Safari 16.0 (no regex lookbehind, `?.`/`??` are fine but unused, no `Array.prototype.findLast`/`toSorted`).
- `/usr/bin/curl` on macOS 13 is 7.84+: `--parallel-immediate` (7.68) and `-w %{urlnum}` (7.75) are available.
- SVG rendering: `NSImage(data:)` reading SVG is only confirmed on macOS 14+; `_NSSVGImageRep` (CoreSVG, macOS 10.15+) is used directly otherwise, then Quick Look (`qlmanage -t`, rendered on white and black and matted with Core Image filters available since macOS 10.15). Not yet run on a real macOS 13 machine: check previews there before calling it verified.

## Verify in real Alfred
- [ ] ⌘⇧↩ copies the SVG URL; `icon`/`logo` with an empty query list recently copied items; ⇧↩ with "Copy to the clipboard" pastes as an image in Keynote/Slack.
- [ ] Previews appear while typing (`rerun`), stop rerunning after 30 tries, and a fast typist never ends up with a stuck "pending" icon.
- [ ] ⌘↩ pastes the SVG into the frontmost app; ⌃↩ copies the name in every "Copy names as" format.
- [ ] ⇧↩ saves the PNG to Downloads/Desktop, reveals it in Finder and shows the notification.
- [ ] The Universal Action "Search Icons" on selected text opens `icon` with that text.
- [ ] ⌘Y Quick Look shows the cached SVG (or the Iconify/svgl page before it is cached).
- [ ] Preview colour "Automatic" follows the Alfred theme (light and dark); svgl light/dark variants are ordered by theme.
- [ ] The About This Workflow text and Workflow Configuration labels read well in Alfred Preferences.

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

## Ideas for v1.1
Ranked by value for effort, from Raycast extension issues (raycast/extensions: Iconify, Svgl, Simple Icons, Lucide) and the features above.
1. **Copy/paste the SVG as a file** (Svgl and Iconify requests, 2025): put the cached SVG on the pasteboard as a file URL for Figma, Finder, Slack and Mail.
2. **Choose the ↩ action** (Iconify requests, 2025): a Workflow Configuration popup for what ↩ does (SVG, paste, JSX, name, PNG), routed with a conditional.
3. **More component formats** (Svgl "Copy as Astro component", 2026): Vue/Svelte/Astro single-file components next to JSX, TSX with typed props.
4. **Filters by icon style** (Iconify "Filter by pack and icon size", 2024): `grid:24`, `palette:mono|color`, `license:mit` using the `/collections` metadata already cached.
5. **Pagination / more results** (Iconify "Pagination loading", 2026): a "Show more" row that reruns with `start=`.
6. **Font previews**: render a font's name in the font itself for the result icon (needs downloading the font file; larger cache).
7. **Clear recently copied** item or modifier, and per-keyword recents limits.
