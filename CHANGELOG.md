# Changelog

All notable changes to **Director's Flick** — a local AI-video pipeline that turns a
narration script + voiceover into a reviewed, auto-cut, exported video.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/); this
project uses [Semantic Versioning](https://semver.org/). Dates are the build sprint.

## [0.1.0] — 2026-07-04

First tagged release. Director's Flick is a complete, locally-run pipeline:
**script + voiceover → forced-aligned per-line shots → AI images → swipe/desktop
review → image-to-video → auto-cut timeline → 1080p export**, driven by a CLI or a
web UI, with multi-account Higgsfield integration and a documented procedure for the
first real-credit pilot. Built by a multi-model agent team coordinated over a shared
board; this entry summarizes what shipped, grouped by area.

### Pipeline core
- Forced alignment of the voiceover to the known script (stable-ts) → per-line word
  timings; a deterministic **timeline rule** (spoken duration, pause, target
  duration) plans one shot per line, splitting lines longer than 15 s into sub-shots
  at word boundaries.
- Crash-safe asynchronous **shot queue** with an explicit state machine
  (`PENDING → PROMPTED → IMAGE_QUEUED → IMAGE_READY → IN_REVIEW → APPROVED →
  VIDEO_QUEUED → VIDEO_READY → PLACED`). Resume rebuilds purely from persisted DB
  state with **no double submission and no phantom charges** on restart, proven by an
  end-to-end crash-recovery suite.
- Adaptive concurrency with per-stage error backoff, and a review-ahead buffer that
  keeps a bounded number of images ready for the reviewer.
- SQLite (WAL) persistence: projects, shots, jobs, EDL, and an account-tagged cost
  ledger.

### Generation providers
- Pluggable `GenProvider` interface (`preflightCost` / `submitImage` / `submitVideo`
  / `poll` / `download`) with a **mock provider** carrying the Phase-0 measured credit
  table for hermetic, zero-cost runs.
- **Higgsfield CLI** adapter: `nano_banana_2` images and `kling3_0` element-tagged
  video, with schema-gated flags so only parameters the installed CLI advertises are
  sent.
- **fal.ai** (Kling 2.5 Turbo Pro) and **Replicate** video fallback adapters, with a
  dollar-denominated ledger and hermetic, injectable HTTP.
- Per-stage provider routing — image and video stages can use different providers.
- **Element-identity placeholders** (`<<<element-uuid>>>`) carry a subject's identity
  instead of a physical description, preventing the character-drift regression seen in
  early live runs.
- Optional **LLM prompt backend** (Anthropic official SDK, structured output) with a
  conservative identity guard and an automatic fall back to the deterministic template
  engine when no key is present or a call fails.

### Review experience
- Review-gate backend: shots stop at `IN_REVIEW` for a human decision, with
  **approve / edit-instructions / redo / redo-animation** actions.
- Desktop review deck and a mobile swipe-review page, fed by a live WebSocket sync.

### Timeline & export
- EDL-driven FFmpeg export: per-clip trim → concat → voiceover mux → **1080p H.264
  (NVENC)** `final.mp4`.
- Guard against silently exporting a partially-placed timeline (explicit `force`
  required).
- **SRT caption sidecar** written next to `final.mp4` (CLI `--srt` and always on
  server export), plus construction of Windows-safe ffmpeg subtitle-burn args.
- Timeline preview playback: voiceover-synced master clock, gapless clip playback, and
  a VO waveform.

### Settings, accounts & cost
- **Multi-account** Higgsfield manager: each account's credentials are isolated and
  selected per project; account switching in the desktop bar and mobile sheet.
- Project configuration endpoints and a Settings page (provider, models, aspect ratio,
  style bible, prompt backend, account).
- Account-tagged **cost ledger** with a unit-aware summary that separates credit- and
  dollar-denominated spend; export/cost API endpoints and a live cost meter.

### Mobile / LAN
- LAN + mobile onboarding (reach the app from a phone on the same network) and a
  responsive review flow.

### Production packaging
- One-command launcher (`scripts/start-directors-flick.ps1`): checks Node + FFmpeg,
  installs dependencies, rebuilds the UI when stale, and starts the backend which also
  **statically serves the built UI**. Friendly port-in-use exit.
- Verified from a cold `git clone` (deps → build → serve → API → WebSocket) and via a
  production-bundle end-to-end smoke against the built app.

### Documentation & quality
- Docs: `README.md`, `app/ARCHITECTURE.md`, `docs/api.md`, `docs/cost-model.md`,
  `docs/user-guide.md`, and `docs/pilot-runbook.md` (the operator procedure for the
  first real-credit pilot, with a measured cost table).
- Extensive hermetic `vitest` suite (330+ tests) covering the queue, providers,
  media/export, server integration, CLI subprocess behavior, and crash recovery, with
  targeted coverage lifts across the riskiest modules.
- **100-shot scale test** preflight (mock, zero credits): all shots placed, EDL
  complete, memory flat, export duration correct — verdict **GO** on scale grounds.

### Reliability & error handling
- Alignment input hardening: malformed, empty, or otherwise unexpected alignment
  inputs are handled defensively, so the pilot's own script/voiceover files cannot
  crash the pipeline mid-run.
- Operator-facing CLI failures print a single friendly line (no stack traces) and
  exit non-zero — e.g. a zero-byte voiceover fails cleanly with one clear message.

### Known limitations (open going into the pilot)
- Real per-job provider latency and real-1080p export wall-clock are not yet
  measured — the scale preflight ran against an instant mock, so these are explicit
  pilot goals.
- Under an instant mock, raising queue concurrency 4→6 shows no throughput gain
  (drain is tick- and buffer-bound); the real 4-vs-6 comparison must be made under
  live provider latency.

[0.1.0]: https://github.com/aniketshaw748-hub/Director-s-Flick/releases/tag/v0.1.0
