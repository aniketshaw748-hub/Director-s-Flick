# Director's Flick — Design System Spec

Authoritative, build-from reference for the Director's Flick UI. Every new screen or
component should be derivable from this document without re-reading the mockups.

**Sources of truth**
- Tokens: `design/tokens.css` (mirrored byte-for-byte into `ui/src/index.css :root`).
- Mockups: `design/desktop-setup.html`, `design/desktop-review.html`,
  `design/desktop-timeline.html`, `design/mobile-review.html`.
- Built pages: `ui/src/App.tsx` (chrome), `ui/src/pages/*.tsx`, `ui/src/player/*`.

**Where the CSS lives** (see §10)
- `ui/src/index.css` — tokens + base reset + app chrome + shared atoms.
- `ui/src/pages/SetupPage.css` — setup screen layout.
- `ui/src/pages/MobileReviewPage.css` — mobile PWA, scoped under `.mobile-review`.
- `ui/src/player/timeline.css` — timeline page + preview player (owned by T-25).
- Review deck is styled inline in `ReviewPage.tsx` on top of the shared atoms.

Dark theme, Higgsfield-flavored: near-black layers + a single lime accent.

---

## 1. Color System

### Background layers (darkest → most elevated)
| Token | Hex | Use |
|---|---|---|
| `--bg-0` | `#0A0A0B` | app root / page |
| `--bg-1` | `#0E0E10` | chrome: rail, topbar |
| `--surface-1` | `#141416` | cards, panels |
| `--surface-2` | `#1A1A1D` | nested surfaces, inputs, hover on surface-1 |
| `--surface-3` | `#212125` | popovers, hover on surface-2 |
| `--overlay` | `rgba(6,6,8,.72)` | modal / bottom-sheet backdrop |
| `--scrim` | gradient | text-over-image legibility |

### Borders (raise on interaction, never color unless accent)
`--border-1` (.07) default hairline · `--border-2` (.12) hover/emphasis · `--border-3` (.18) active-not-accent.

### Text
`--text-1` `#F2F3EE` primary · `--text-2` `#A5A8A0` labels/meta · `--text-3` `#6E716A` hints/timecodes-at-rest · `--text-disabled` `#494B44`.

### Lime accent (the signature — the ONLY green)
`--lime` `#C6FF4D` base · `--lime-bright` `#D7FF7B` hover-on-fill · `--lime-deep` `#A8E635` pressed · `--lime-ink` `#121600` text/icons ON lime.
Tints: `--lime-a08` (row bg) · `--lime-a12` (chip bg) · `--lime-a20` (tint border) · `--lime-a35` (strong border / focus ring).

**Rules**
- Never white text on lime — always `--lime-ink`.
- Success == `--lime` (approve IS the primary action; there is exactly one green).
- `--danger` `#FF5C5C` reject/destructive/failed · `--warn` `#FFB454` moderation/low-balance/trims · `--info` `#8AB8F0` rare neutral notices.
- Each semantic has `-a12` (tinted bg) and `-a35` (border/glow) variants.

---

## 2. Typography

Two self-contained stacks, no web fonts / CDNs:
- **`--font-sans`** — Inter/Geist → Segoe UI Variable → system-ui. All prose and UI.
- **`--font-mono`** — Geist Mono/JetBrains Mono → Consolas. The "instrument readout" voice:
  **ALL** timecodes, durations, credits, counts, job ids. **Never** for prose.

### Type scale
`--fs-11` overlines/kbd (uppercase +.08em) · `--fs-12` meta/chips/mono readouts · `--fs-13` list rows/secondary · `--fs-14` base body/controls · `--fs-16` review script line · `--fs-18` panel titles · `--fs-22` page titles · `--fs-28` big numbers (est. credits, export %).

### Weight / line-height / tracking
Weights `--fw-regular 400` … `--fw-bold 700` (bold reserved for big numbers).
Line-height: `--lh-tight 1.2` headings/numbers · `--lh-body 1.5` prose · `--lh-ui 1.35` controls.
Tracking: `--track-tight -.02em` headings ≥18px · `--track-caps .08em` uppercase overlines.

---

## 3. Spacing & Radius

**Spacing** — 4px base grid, `--sp-1`(4) … `--sp-16`(64). Card padding `--sp-5`; page padding `--sp-8`.

**Radius** — `--r-sm` 8 (chips, kbd, small thumbs) · `--r-md` 12 (buttons, inputs, queue items) · `--r-lg` 16 (cards, panels) · `--r-xl` 20 (hero review card, player) · `--r-2xl` 24 (bottom sheet, dialogs) · `--r-full` 999 (pills, dots, avatars).

---

## 4. Elevation, Glow & Focus

- Shadows: `--shadow-1` low · `--shadow-2` cards/circles · `--shadow-3` dialogs/sheets/popovers.
- Glows: `--glow-lime` / `--glow-lime-strong` (active primary, approve button, playhead), `--glow-danger`.
- **Focus ring** — `--focus-ring` = `0 0 0 2px var(--bg-0), 0 0 0 4px var(--lime-a35)`, applied via
  `:focus-visible` on every interactive element (`button`, `textarea`, `input`, `a`, `.nav-btn`).
  Keyboard-only (`:focus-visible`, never bare `:focus`), works on round elements (box-shadow, shape-agnostic).

---

## 5. Motion & Interaction

Durations: `--t-fast` 150ms (hover, focus, chip toggles) · `--t-med` 200ms (card enters, popovers, queue reorder) · `--t-slow` 250ms (bottom-sheet slide, dialog scale-in, swipe fly-out).
Easing: `--ease` `cubic-bezier(.2,0,0,1)` standard · `--ease-out` `cubic-bezier(.16,1,.3,1)` decelerate (enters, sheets).
**Reduced motion** — `@media (prefers-reduced-motion: reduce)` collapses all `--t-*` to 0ms; swipe cards snap instead of animating. Honor it.

---

## 6. Component Inventory (classes + states)

### App chrome (shared desktop — `index.css`)
- **`.rail`** — 64px left icon rail, `--bg-1`. `.logo` (lime, glow-lime). `.nav-btn` 40px, `--text-3`
  at rest → hover `--surface-2`/`--text-1` → `.active` lime-a08 bg + `--lime` icon + 2px lime bar (`::before`)
  + focus-ring. `.avatar` bottom.
- **`.topbar`** — 60px, `--bg-1`, hairline bottom. `.proj` (name `--fw 600` + `.proj-meta` `--text-3`) doubles as the project switcher and projects list dropdown,
  `.top-spacer`, account chip, `.conn`.
- **`.account-chip`** — pill, `--surface-1`, initial (lime tinted circle) + `.name` + `.cr` (mono, lime) + `.caret`.
  Hover/`.active` → `--surface-2`/`--border-2`. Opens the account dropdown. Fetches live balances via `/api/accounts`.
- **Account dropdown** — `--surface-1`, `--shadow-3`. Rows: active row lime-tinted initial + `--lime` check;
  **auth-expired** row shows "Session expired" in `--danger` in place of the balance. "Add account" ghost row at bottom.
- **`.conn`** — pill status. Online: `.dot` lime + glow + "LAN · live". **Disconnected**: red dot + `--danger` text "offline" + `--danger-a35` shadow.

### Common atoms (`index.css`)
- **`.overline`** — 11px uppercase `.08em` `--text-3`.
- **`.card`** — `--surface-1`, hairline, `--r-lg`.
- **`.chip`** — 24px pill, hairline. `.chip-lime` (aligned/ok), `.chip-warn` (e.g. "VO differs").
- **`.at-chip`** — mono lime pill for `@element` mentions inline in prompts/labels.
- **Buttons** — `.btn` base (40px, `--r-md`). `.btn-primary` lime/lime-ink, hover bright+glow, active deep,
  disabled surface-3. `.btn-secondary` surface-2/hairline. `.btn-ghost` 32px text-2, hover surface-2.
- **`.btn-circle`** — 64px round action (shadow-2). Hover scale 1.05 + surface-3; active scale .92; disabled dim.
  `.btn-reject` danger icon, danger border on hover. `.btn-approve` lime fill + glow (desktop overrides to 72px inline).

### Review deck (`ReviewPage.tsx`, inline + atoms)
- **`.buffer-indicator`** — top-left pill "Buffer" + 5 dots (empty `--surface-3` → ready `--lime` + glow) = review-ahead buffer (N=5) fill. Counts `IN_REVIEW` shots.
- **Review card** — 800px, `--surface-1`, `--r-xl`, `--shadow-3`: image area (450px, contain) over body
  (`L{n}/{total}` + model, mono; script line 18px; prompt 14px `--text-3` with `.at-chip`s). Placeholder SVG when no image. Shows `Attempt N` on moderation retries.
- **Deck controls** — reject (`← OR E`) + approve (`→ OR ENTER`) circles with mono kbd hints. Uses `acting` state to guard against double-submits.
- **Edit panel** — slides in from right via `transform: translateX(0)` vs `translateX(120%)` (`--t-slow` `--ease-out`). "Edit instructions" (→ image-to-image) + OR + "Rewrite prompt"
  (→ redo) textareas, each with `@`-mention autocomplete.

### `@`-mention autocomplete (`index.css`, `useAutocomplete.tsx`)
- **`.autocomplete-popover`** — `--surface-3`, `--shadow-2`, anchored under the textarea; `.ac-item`
  (thumb + `@name`), active/hover → `--surface-1`/`--lime`. Typing `@` filters project elements; select visually inserts an `@Element` `.at-chip` but underlying value is `<<<id>>>`. Used in Edit Panel and Timeline Redo Animation dialog.

### Setup screen (`SetupPage.css`)
- **`.content`** — grid `minmax(640,1fr) 380px`, max 1560. `.page-head` (h1 22px + sub).
- **Upload cards** — `.script-box` / `.wave-box` (waveform bars `--wave`), mono `.meta`, ghost Replace.
- **Alignment** — `.align-card`: `.chip-lime` "aligned · stable-ts", `.align-row` (`.ln` mono / `.txt` ellipsis / `.time` mono / `.dur` pill),
  `.pause` dashed dividers, `.align-fade` bottom scrim, `.align-foot` total. `.chip-warn` "VO differs" per-line.
- **Right panels** — Elements (`.el-row` thumb + `.at-chip` + kind/refs; `.el-create` dashed CTA), Style bible (`.bible`),
  Models & cost (`.cost-row`, `.cost-total .big` 28px lime, `.balance-bar`). `.start` primary CTA + caption.

### Mobile review PWA (`MobileReviewPage.css`, scoped `.mobile-review`)
- **`.topbar`** — slim 56px, back chevron / center title / credits chip.
- **`.card-stack`** — `.swipe-card` (`.card-bg` behind, `.card-fg` front): `.card-image` fills, `.card-content`
  (`.card-line` 16px + `.card-prompt` clamped 3 lines).
- **`.actions`** — reject/approve circles, safe-area padding (`env(safe-area-inset-bottom)`).
- **Bottom sheet** — `.sheet` slides up (`--r-2xl` top), `.sheet-handle`, `.sheet-title`, `.btn-row` actions; `.sheet-backdrop`.

### Timeline & export (`player/timeline.css` — T-25)
- Player (`.player-container` 16:9, `.play-btn` lime, `.timecode` mono). `Space` toggles play.
- Export panel (`.stats-row`, `.progress-bar`/`.progress-fill`, Export). Shows live progress stages (trim → concat → mux → done). "Export partial" confirm dialog rendered inline when `placed < total`.
- Timeline strip (`.tl-ruler` mono ticks, `.tl-clip` thumbs, `.tl-audio-wave` bars w/ `.played`), `.playhead` (lime 2px + glow).
- Redo Animation — toolbar button opens an inline prompt textarea with autocomplete, submitting `redoAnimation` action to replace the clip inline.

---

## 7. State rules (must be handled on every screen)

- **Focus** — keyboard focus ring on all interactives (§4). Rail links included.
- **Empty — no shots** — Review deck & mobile show "No shots to review right now."; Timeline shows
  "No placed clips yet — approve shots in Review…"; Setup shows a 2-line demo fallback until real shots arrive.
- **Disconnected WS** — `.conn` flips to red dot + "Disconnected" the moment the socket closes/errors; queue state
  survives, UI keeps last `sync`.
- **Auth-expired account** — dropdown row shows "Session expired" (`--danger`) instead of a balance; switching to it must re-auth.
- **Attempt / retry** — review card shows `Attempt N` when `shot.attempts > 1`. Failed jobs use `--danger`; moderation retries `--warn`.

---

## 8. Per-screen annotations

- **Setup** — two-column workspace (max 1560), start button queues first 5 images; cost panel is pre-flighted `get_cost`, not a guess.
- **Review deck** — keyboard: `→`/`Enter` approve, `←`/`E` open reject/edit. Buffer indicator reflects the N=5 review-ahead buffer.
- **Mobile review** — same actions as a bottom sheet; installable PWA (manifest + viewport-fit=cover, no user-scaling).
- **Timeline** — VO audio is the master clock; A/B `<video>` swap; click-to-seek; `Space` toggles play; "Redo animation" re-generates the selected clip.

---

## 9. Content vs. branding note

The "Hapie & the Lighthouse" script/character text in the mockups and demo fallbacks is **intentional demo data**
(the Phase-0 test project), not app branding — keep it. Product name is "Director's Flick" everywhere in chrome.

---

## 10. CSS architecture & caveats

- **One token source.** `ui/src/index.css :root` mirrors `design/tokens.css`. Change tokens there and keep them in sync.
- **Layering.** `index.css` (global: tokens + base reset + chrome + atoms) loads first; page CSS is imported by its page
  component; `timeline.css` is statically bundled (TimelinePage is imported eagerly), so `.btn`/`.mono`/`.workspace` it also
  defines are available app-wide.
- **`.workspace`** is defined in `index.css` with `position: relative` (anchors the review deck's absolutely-positioned
  buffer/controls/edit-panel); `timeline.css` redefines the flex props identically but never sets `position`, so the relative
  context always holds.
- **No `min-width` on `body`.** The `/mobile` route shares the document `<body>`; a desktop `min-width` would break the phone PWA.
  Desktop pages assume a wide viewport instead.
- **Mobile scoping.** All mobile styles are namespaced under `.mobile-review` so the mobile `.topbar`/`.account-chip`/`.at-chip`
  never clobber the desktop chrome.
- **Contract caveat.** `ElementRef` (app/src/types.ts) now appears to supply `.thumbUrl` which is consumed by the UI for element cards.

---

## 11. Spec-vs-built drift findings

- **App Chrome:** Project name in topbar now doubles as a full project switcher/dropdown. Connection dot displays "offline" instead of just "Disconnected".
- **Review Deck:** Filters on `IN_REVIEW` instead of `IMAGE_READY`. Buffer indicator correctly counts `IN_REVIEW` shots to show the true state of the review-ahead buffer.
- **Export Panel:** No native confirm dialogs; the "Export partial" warning is rendered inline in the panel. The "Cancel" button during export is not implemented (no backend cancel endpoint exists).
- **Redo Animation:** The Timeline page has a fully wired "Redo animation" inline popover with autocomplete, reusing the autocomplete popover styling.
- **Elements:** Element cards are consuming `thumbUrl`, updating the previous caveat that elements had no image paths.
