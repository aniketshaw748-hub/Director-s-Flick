# Director's Flick — Design System Spec

This document serves as the single source of truth for the Director's Flick design system, detailing tokens, components, interaction rules, and per-screen annotations. It is derived from the CSS variables defined in `design/tokens.css` and the Phase-2 HTML mockups.

## 1. Color System

The application uses a dark theme with near-black layers and a signature lime accent color.

### Background Layers (Darkest → Most Elevated)
- **`--bg-0` (#0A0A0B)**: App root / page background.
- **`--bg-1` (#0E0E10)**: Chrome elements (sidebar, topbar, rails).
- **`--surface-1` (#141416)**: Standard cards, panels, list items.
- **`--surface-2` (#1A1A1D)**: Nested surfaces, inputs, hover states on `surface-1`.
- **`--surface-3` (#212125)**: Highest elevation surfaces (popovers), hover on `surface-2`.
- **`--overlay`**: `rgba(6, 6, 8, 0.72)` for modal/sheet backdrops.
- **`--scrim`**: Linear gradient `180deg, rgba(6,6,8,0) 0%, rgba(6,6,8,0.82) 100%` for text-over-image legibility.

### Borders
- **`--border-1` (rgba(255, 255, 255, 0.07))**: Default hairline on all surfaces.
- **`--border-2` (rgba(255, 255, 255, 0.12))**: Hovered or emphasized borders.
- **`--border-3` (rgba(255, 255, 255, 0.18))**: Active but not accent-colored.

### Text
- **`--text-1` (#F2F3EE)**: Primary text (slightly warm-green white).
- **`--text-2` (#A5A8A0)**: Secondary text (labels, meta information).
- **`--text-3` (#6E716A)**: Tertiary text (hints, timestamps at rest).
- **`--text-disabled` (#494B44)**: Disabled states.

### Lime Accent (The Signature)
Used for primary actions, active states, playhead, and progress bars.
- **`--lime` (#C6FF4D)**: Base accent.
- **`--lime-bright` (#D7FF7B)**: Hover state on lime fills.
- **`--lime-deep` (#A8E635)**: Pressed state on lime fills.
- **`--lime-ink` (#121600)**: Text/icons ON lime fills. **Rule: Never use white text on lime backgrounds.**
- Alpha tints: `--lime-a08`, `--lime-a12` (tinted chip/row bg), `--lime-a20` (tinted border), `--lime-a35` (strong tinted border/focus ring).

### Semantic Colors
- **Success**: Always uses `--lime`. There should only be one green.
- **Danger (`--danger`, #FF5C5C)**: Rejection, destructive actions, failed jobs.
- **Warning (`--warn`, #FFB454)**: Moderation retries, low balance, trim boundaries.
- **Info (`--info`, #8AB8F0)**: Rare, neutral notices only.

---

## 2. Typography

Two primary font stacks without external CDNs (relies on system fonts and standard fallbacks):
1. **Sans-Serif (`--font-sans`)**: "Inter", "Geist", "Segoe UI Variable Display", system UI.
2. **Monospace (`--font-mono`)**: "Geist Mono", "JetBrains Mono", "Cascadia Code", monospace.
   - **Rule**: Mono is the "instrument readout" voice. Use it for ALL timecodes, durations, credits, counts, and job IDs. Never use it for prose.

### Type Scale
- **`--fs-11` (11px)**: Keyboard caps, overline labels (uppercase, +0.08em tracking).
- **`--fs-12` (12px)**: Meta text, chips, queue states, mono readouts.
- **`--fs-13` (13px)**: Secondary UI text, list rows.
- **`--fs-14` (14px)**: Base body / controls (default).
- **`--fs-16` (16px)**: Emphasized body (e.g., script line on review cards).
- **`--fs-18` (18px)**: Panel titles.
- **`--fs-22` (22px)**: Page/section titles.
- **`--fs-28` (28px)**: Display text, big numbers (est. credits, export %).

### Line Heights
- **`--lh-tight` (1.2)**: Headings, big numbers.
- **`--lh-body` (1.5)**: Prose, script lines.
- **`--lh-ui` (1.35)**: Buttons, chips, rows.

---

## 3. Spacing & Radius

### Spacing (4px Base Grid)
- Variables range from `--sp-1` (4px) to `--sp-16` (64px).

### Border Radius
- **`--r-sm` (8px)**: Chips, keyboard hints, small thumbnails.
- **`--r-md` (12px)**: Buttons, inputs, queue list items.
- **`--r-lg` (16px)**: Cards, panels ("rounded-2xl" appearance).
- **`--r-xl` (20px)**: Hero review card, preview player.
- **`--r-2xl` (24px)**: Bottom sheet top corners, dialogs.
- **`--r-full` (999px)**: Pills, dots, avatars.

---

## 4. Component Inventory & States

### Elevation & Glows
- **Shadows**: `--shadow-1` (low), `--shadow-2` (medium), `--shadow-3` (high - dialogs, sheets, popovers).
- **Glows**: `glow-lime` and `glow-lime-strong` provide a soft neon aura around active primary actions and the playhead.

### Focus Ring
- Universal focus ring: `0 0 0 2px var(--bg-0), 0 0 0 4px var(--lime-a35)`. Should be applied on `:focus-visible`.

### Buttons
- **Primary (`.btn-primary`)**: `--lime` bg, `--lime-ink` text. Hover: `--lime-bright` + strong glow. Active: `--lime-deep`.
- **Secondary (`.btn-secondary`)**: `--surface-2` bg, `--border-1` border. Hover: `--surface-3` bg, `--border-2` border.
- **Ghost (`.btn-ghost`)**: `--text-2` color, transparent bg. Hover: `--surface-2` bg, `--text-1` color.
- **Circular Icon Buttons (`.btn-circle`)**: Elevated shadow-2 buttons. Hover expands scale slightly (`transform: scale(1.05)`).

### Account Switcher Dropdown (Top Bar)
- **Base State**: Pill-shaped button showing initial, account name, and credit balance.
- **Active/Hover State**: Changes bg to `--surface-2`.
- **Dropdown List (`.account-dropdown`)**:
  - Displays list of accounts. Active account highlighted with lime background on initial and a checkmark.
  - **Auth-Expired State**: If session is expired, displays "Session expired" in `--danger` red, replacing the balance.
  - **Add Account**: Ghost button at the bottom of the list.

### Mentions (Autocomplete & Chips)
- **Autocomplete Popover (`.autocomplete-popover`)**: Floating list of elements (thumbnail + name). Active item gets `--surface-1` background and `--lime` text.
- **@ Mention Chip (`.at-chip`)**: Inline pill inside text areas or card prompts. Uses mono font, `--lime-a12` background, and `--lime` text.

---

## 5. Motion & Interaction Rules

Animations should feel snappy but fluid.
- **Fast (`--t-fast`, 150ms)**: Hovers, focus states, chip toggles.
- **Medium (`--t-med`, 200ms)**: Card enters, popovers, queue list reordering.
- **Slow (`--t-slow`, 250ms)**: Bottom sheet slide-up, dialog scale-in, swipe fly-out.
- **Easing**:
  - Standard: `cubic-bezier(0.2, 0, 0, 1)`
  - Decelerate (enters, sheets): `cubic-bezier(0.16, 1, 0.3, 1)`

**Accessibility**: Respect `prefers-reduced-motion` by dropping durations to `0ms`. The core functionality (like swipe cards) should snap immediately instead of sliding.

---

## 6. Per-Screen Annotations

### Setup Screen (`desktop-setup.html`)
- Two-column layout (max width 1560px).
- Audio waveform uses a static visual representation (bars) with `--wave` for unplayed and `--lime` for played sections.
- Alignment list features a bottom fade gradient (`linear-gradient(180deg, rgba(20,20,22,0), var(--surface-1))`) to indicate scrolling depth.
- **Empty States**: If no elements exist, display a placeholder in the element panel pointing to the "Create element" button.

### Review Deck (`desktop-review.html` / `mobile-review.html`)
- **Deck Area**: Centered stack of cards.
- **Buffer Indicator**: Pill at top-left indicating queued shots (dots: `--surface-3` empty, `--lime` with glow if ready).
- **Controls**: Reject (←/E) triggers the edit panel/sheet. Approve (→/Enter) triggers swipe-right exit animation on the card.
- **Edit Panel/Sheet**:
  - Desktop: Slides in from the right.
  - Mobile: Slides up from the bottom (bottom sheet with `--r-2xl` top corners).
  - Contains two actions: Apply Edit (Image-to-Image) and Redo Generation (Rewrite prompt).

### Timeline & Export (`desktop-timeline.html`)
- **Preview Player**: 16:9 box with `--r-xl` radius.
- **Timeline Tracks**: VO Track (audio) is the master clock. Video track contains clip segments.
- **Playhead**: Vertical line extending through tracks. Uses `--lime` with a 6px glow.
- **Export Panel**: Shows total duration, shots approved, and estimated cost. Export button replaces with a progress bar (`--lime` fill) when active.
