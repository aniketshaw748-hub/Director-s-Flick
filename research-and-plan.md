# AI Video Pipeline — Deep Research Report & Build Plan

**Date:** 2026-07-03 · **Research method:** 106-agent deep-research workflow (5 search angles → 24 sources fetched → 118 claims extracted → 25 adversarially verified: 21 confirmed, 4 refuted) + live checks against the Higgsfield MCP connected to this machine.

**Locked decisions (from PRD + Q&A):** built-in lightweight editor with FFmpeg export (no Premiere) · MCP-first generation with direct-API fallback · high volume (multiple 10-min videos/month) on a paid Higgsfield plan · narrative stories with recurring characters.

---

## Part 1 — Research Findings

Verification labels: **[3-0]** = survived 3-vote adversarial verification · **[2-1]** = medium confidence · **[LIVE]** = confirmed directly against your Higgsfield MCP on 2026-07-03 · **[EJ]** = engineering judgment (no claim survived verification in this area; treat as informed opinion).

### 1. Higgsfield MCP — the primary generation path

- **[3-0]** MCP-first from Claude Code is a *vendor-supported* path. Official server: `https://mcp.higgsfield.ai/mcp`, added with `claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp`. Auth is **Higgsfield-account OAuth — no API keys**. Sources: [higgsfield.ai/mcp](https://higgsfield.ai/mcp), official blog.
- **[3-0]** **MCP generations always burn metered credits.** They draw from the same plan credit pool as the web app, priced per generation by model/resolution — but "Unlimited" models and free generations are **web-only and never apply on MCP/CLI/Canvas**. Credit top-ups ≈ **$0.06/credit**. Budget on hard credit costs; never count web "Unlimited" perks. Sources: [higgsfield.ai/mcp](https://higgsfield.ai/mcp), [higgsfield.ai/pricing](https://higgsfield.ai/pricing), live `show_plans_and_credits`.
- **[LIVE]** Your account: **Team plan, 2,048.58 credits** as of 2026-07-03.
- **[LIVE]** **Kling 2.5 Turbo no longer exists in the MCP catalog.** Current Kling options:
  - `kling2_6` — 5s or 10s, `start_image`, optional native audio, 16:9/9:16/1:1.
  - `kling3_0` — **3–15s continuous duration**, `std`/`pro`/`4k` modes, `start_image` + `end_image`, sound on/off.
  - `kling3_0_turbo` — **3–15s continuous**, 720p/1080p, `start_image`, tagged "budget". Likely your workhorse.
  - Strong alternates: `seedance_2_0` (4–15s, `start_image` + `image_references` for identity, up to 4K, `generate_audio:false` for silent clips), `seedance_2_0_mini` (budget), `minimax_hailuo`, `wan2_7` (character-consistent), `veo3_1` / `veo3_1_lite`.
  - The 3–15s continuous range on Kling 3.0/Turbo and Seedance 2.0 is **better than the old 5s/10s enum** — you can generate a clip near each line's actual length and waste fewer seconds.
- **[LIVE]** `models_explore` does **not** expose per-generation credit costs. Per-clip credit cost on Higgsfield is only observable empirically (generate → diff `balance`). This is Phase 0 work.
- **[3-0]** MCP capability envelope: images up to 4K (`nano_banana_pro`, `upscale_image` to 2K/4K), **video capped at 15s/clip across the entire catalog** (fine — your per-line clips are shorter), Soul training via `show_characters(action='train')`.
- Pipeline-relevant MCP tools (present in the live tool list): `generate_image`, `generate_video`, `job_status`, `job_display`, `media_upload`, `media_import_url`, `media_confirm`, `show_characters`, `show_reference_elements`, `models_explore`, `presets_show`, `balance`, `transactions`, `upscale_image`/`upscale_video`, `reveal_generation`, `show_generations`.
- **Unverified / open:** OAuth token lifetime under long unattended runs, MCP-side rate limits, and queue behavior when many jobs are submitted concurrently. Nothing in the docs settles this — design for it (see Risks).

### 2. Character & style consistency (recurring characters across 100+ shots)

- **[3-0]** **Soul training**: `show_characters(action='train')` takes **5–20 reference images**, trains **~10 minutes**, returns a reusable **`soul_id`**.
- **[3-0]** Key constraint: a trained `soul_id` works **only with Soul V2 / Soul Cinema image models** — there is no direct video-side Soul. Video-side character consistency is achieved **indirectly**: generate the character-consistent *still* with Soul 2.0 (`soul_id`), then pass it as `start_image` to the video model. That is exactly your pipeline shape, so this constraint costs you nothing.
- **[LIVE]** Confirmed schemas: `soul_2` / `soul_cinematic` accept `soul_id`; `soul_cast` ("consistent cinematic character identity") and `soul_location` (environments) also exist.
- **[LIVE]** **Elements** (`show_reference_elements` — the web UI's `@element` feature): reusable **character / environment / prop** references created *instantly* from 1+ images (no training). Referenced in generation by embedding `<<<element_id>>>` placeholders in the prompt (backend injects the images and rewrites to `@element_name`); multiple elements per prompt. Supported on image models `nano_banana_2`/`nano_banana_flash`, `gpt_image_2`, `seedream_v4_5`/`v5_lite`, `cinematic_studio_2_5` and — crucially — on **video models Kling 3.0, Seedance 2.0, Cinema Studio Video** (NOT on Soul V2/Cinema). Three capabilities Soul lacks: video-side identity lock, **multiple subjects in one shot**, and non-person subjects (locations, props). `create` accepts a completed `image_job` UUID directly, so an approved generation can be promoted to an Element in one call. Account already has element `Hapie-ai-bot` (character).
- **DECISION (user, 2026-07-03): Elements-first.** Elements are the primary consistency mechanism for all recurring characters, locations, and props — instant to create, `@name`-referencable, multiple per shot, and usable on both image and video models. Workflow: at project setup, Claude parses the script → proposes the recurring cast/locations/props → each gets an Element (created from uploads or promoted from approved generations via `image_job` id) → the prompt-generation step auto-tags each line's prompt with the relevant `<<<element_id>>>` placeholders. Soul is demoted to an optional special case (single-protagonist face fidelity in hero close-ups) — note the two systems don't mix in one call, since Elements don't work on Soul V2/Cinema models.
- Elements-first shifts image generation to Element-compatible models — primary: Nano Banana Pro (2 credits/image verified) or Nano Banana 2 / Cinema Studio Image 2.5 (costs unverified — measure in Phase 0). ~100 shots ≈ ~200 credits (~$12) at NB Pro rates vs ~12 credits via Soul; still minor next to video cost. ⚠ Machine-name drift between MCP surfaces: the Elements tool maps `nano_banana_2`→"Nano Banana Pro" and `nano_banana_flash`→"Nano Banana 2", while `models_explore` lists `nano_banana_pro` and `nano_banana_2` separately — resolve the correct IDs empirically in Phase 0, never hardcode.
- **[3-0]** Image economics: **Soul 2.0 = 0.12 credits/image**, Soul v1 = 0.25, Nano Banana Pro = 2 (4 at 4K). 100+ character stills ≈ **12–25 credits — negligible**. Caveat: the *Character feature* is tier-capped on individual plans ("up to 48/320/720 generations", 1/2/3 concurrent on Basic/Pro/Max). **Team-plan caps are unknown — check in Phase 0.** Source: live-rendered [higgsfield.ai/pricing](https://higgsfield.ai/pricing).
- Style lock **[EJ]**: hold style in a per-project "style bible" (prompt prefix + palette + lens/lighting vocabulary) injected into every prompt-generation call, plus `presets_show` preset IDs where applicable. Character lock = `soul_id` + canonical wardrobe/feature description in the bible (Soul controls the face; clothing/props must be re-stated in prompts).

### 3. Fallback generation APIs

- **[3-0]** **fal.ai and Replicate both host your exact model** (Kling 2.5 Turbo Pro) at identical pricing: **$0.35 per 5s clip, +$0.07 per extra second ($0.07/sec)**. fal prices image-to-video the same as text-to-video. ~100 clips ≈ **$35 (all 5s) – $70 (all 10s)** per video.
- **[3-0]** Fallback API mechanics fit the queue design: duration is **enum-locked to exactly 5 or 10s** (so trim-in-editor is mandatory there); Replicate supports `start_image` ("first frame") with `aspect_ratio` ignored when it's provided; fal is key-authenticated (`FAL_KEY`) with an **async queue** (`fal.queue.submit` → status/result, webhooks with 10 retries over 2h). Browser-free parallel generation, ideal for review-ahead buffering.
- **[3-0]** **Higgsfield also runs a direct REST API** ("Higgsfield Cloud", `platform.higgsfield.ai`, `Authorization: Key {key}:{secret}`, async request_id → poll status: `queued/in_progress/nsfw/failed/completed`, official JS + Python SDKs). BUT: video docs list only Kling **v2.1 Pro**, Seedance v1 Pro, DoP — no 2.5 Turbo; and the modern Soul endpoint docs expose **no `soul_id`/reference params** (only the legacy SDK does, on old routes). API-side character consistency is **unconfirmed** — the MCP is currently the better Higgsfield surface for your use case.
- **[3-0]** **Official Kling API is the cheapest verified path**: Kling 2.5 Turbo at **$0.21 std / $0.35 pro per 5s** ($0.42/$0.70 per 10s); start/end-frame image-to-video is **pro-only**. ~100 × 5s std ≈ **$21/video**. **[2-1]** Concurrency is a fixed per-tier cap that does **not** grow by buying more resource packs (~5 trial / ~20 standard reported); enterprise-only negotiation above that.
- Quality caveat (open): whether Kling 2.6/3.0 output matches your established 2.5 Turbo look is **unverified** — test side-by-side in Phase 0 before switching models.

### 4. Script ↔ voiceover alignment (local, 6GB VRAM)

- **[3-0]** **WhisperX** (v3.8.6): batched ASR ~70× realtime best-case (~14× real-world) with **wav2vec2 forced alignment → ~50–100ms word accuracy**. faster-whisper large-v2 runs in <8GB at beam 5; **int8 large-v2 batch 8 ≈ 4.5GB VRAM** — fits the 4050 with `--compute_type int8 --batch_size 4-8`, or load ASR/alignment models sequentially. Plain Whisper timestamps are utterance-level and can drift by seconds **[2-1]** — not good enough for frame-accurate cuts.
- **[3-0]** **ctc-forced-aligner**: 300M-param MMS CTC model (~0.6GB fp16), CUDA or CPU, aligns *provided text* to audio directly. (Its "5× less memory than TorchAudio" marketing was **refuted 0-3** — the tool itself is verified viable, the comparison isn't.)
- **Recommendation:** you already *have* the exact script, so pure forced alignment is the right primitive — **ctc-forced-aligner as primary** (tiny, aligns your known text), **WhisperX as cross-check** (its ASR also catches places where the recorded VO diverges from the script). Pause detection falls out of the word timestamps: a gap ≥ ~250–400ms between line-final and line-initial words is a cut boundary; line duration = last-word end − first-word start (+ half of each adjacent pause).

### 5. Built-in editor & export **[EJ — no verified claims in this area]**

- **The "editor" is 95% an assembler.** The data model is a simple EDL: per line `{lineId, clipPath, inPoint, outPoint, timelineStart, duration}` in SQLite. Cuts only — no transitions, no layering — which removes almost all the hard NLE problems.
- **Preview:** all clips are short, freshly-generated H.264 MP4s. In Chromium, `<video>` elements hardware-decode via NVDEC/D3D11 natively — 1080p30 playback of pre-gapped short clips is trivial on a 4050. Strategy: two alternating `<video>` elements (A/B), preload next clip while current plays, swap at boundary, voiceover as a single `<audio>` master clock. No WebCodecs compositing needed for a cuts-only timeline; 6GB VRAM is a non-issue for playback.
- **Export:** FFmpeg with **NVENC** (`h264_nvenc`): per-clip trim+normalize pass (`-ss/-t`, `fps=30,scale=1920:1080`, NVENC — parallelizable, each clip is seconds of work), then **concat demuxer with `-c copy`** (instant), then mux the voiceover WAV (`-map 0:v -map 1:a -c:v copy -c:a aac`). ~100 clips → export in low single-digit minutes. Normalizing every clip to 30fps CFR at the trim step is what guarantees "no stutter" — generated clips arrive at mixed 24/25/30fps.
- **Reuse candidates** (sources fetched but claims unverified): [designcombo/react-video-editor](https://github.com/designcombo/react-video-editor) (React timeline UI to crib from), [omniclip](https://github.com/omni-media/omniclip) (WebCodecs editor). Remotion is the wrong tool here (programmatic compositing/rendering, company license, CPU-heavy) — FFmpeg direct is simpler and faster for pure cuts. Recommendation: **build the thin timeline yourself** (it's a list of trims), borrow UI patterns from react-video-editor.

### 6. Orchestration backbone **[EJ + primary-doc claims that weren't in the verified top-25]**

- Claude Code runs headless via `claude -p` (batch: reads prompt, runs to completion, exits) with `--output-format stream-json`; the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` npm / `claude-agent-sdk` pip) exposes the same engine as a library — `query()` async generator, MCP servers attachable, PreToolUse hooks with allow/deny/ask/**defer** (defer ends the query resumably — a natural human-review gate). Sources: [code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless), [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview).
- **Critical design split — creative vs. mechanical calls:**
  - **Creative (needs an LLM):** image prompts from script lines (+style bible), animation prompts from approved images, edit-instruction → revised prompt. Use the Agent SDK with Sonnet; batch ~5 lines per call as in your current manual flow.
  - **Mechanical (no LLM needed):** `generate_image`/`generate_video`/`job_status`/download calls. The Higgsfield MCP is just an HTTP MCP server — the app can speak MCP **directly** via `@modelcontextprotocol/sdk` using the same OAuth credentials Claude Code stores, no LLM tokens burned per generation, fully deterministic, and trivially parallel. Claude stays in the loop only where intelligence is needed.
- **Job queue:** SQLite state machine per shot: `PENDING → PROMPTED → IMAGE_QUEUED → IMAGE_READY → IN_REVIEW → (APPROVED | EDIT | REDO) → VIDEO_QUEUED → VIDEO_READY → PLACED`, plus `redo-from-timeline` re-entering at VIDEO_QUEUED with the same start_image + new animation prompt (exactly the PRD's timeline-redo behavior). Review-ahead: keep N≈5 shots at IMAGE_READY at all times; approving shot k immediately queues image k+N. Everything persisted → crash/restart resume is free.

### 7. Android review companion **[EJ]**

- The built-in-editor decision makes this nearly free: ship the whole UI as a **local web app** (Fastify/Express + WebSocket on the PC, bound to `0.0.0.0`), open `http://<pc-lan-ip>:port` on the phone. Swipe review as a mobile-first **PWA** (installable, fullscreen, touch gestures via pointer events). WebSocket pushes new IMAGE_READY cards to whichever screen is open; approvals sync instantly both ways. No native app, no store, no extra codebase. (Windows Firewall: allow the port on Private networks.)

### 8. Cost & feasibility

| Path | Video cost per 10-min video (~100 clips) | Status |
|---|---|---|
| Higgsfield MCP — **measured 2026-07-03** (see Phase 0 Results below) | kling3_0 std silent **6.25 cr/5s ($0.375)** → ~750 cr ≈ **$45**; kling2_6 5 cr/5s ($0.30) → ~$36; kling3_0_turbo 1.5 cr/s | ✅ measured |
| fal.ai / Replicate, Kling 2.5 Turbo Pro | **$35–70** ($0.07/sec, 5s/10s enum) | ✅ [3-0] |
| Official Kling API, 2.5 Turbo std | **~$21** (I2V needs pro → ~$35); fixed concurrency caps | ✅ [3-0] / [2-1] |
| Images, Elements-first (Nano Banana Pro @ 2 cr) | **~200–300 credits ≈ $12–18** incl. re-rolls; cheaper NB2/Cinema 2.5 rates unmeasured | ✅ [3-0] price / ⚠ model TBD |
| Images, Soul route (0.12 cr, optional hero shots) | **~12–25 credits ≈ $1–1.50** | ✅ [3-0] |

- Breakeven rule of thumb: at $0.06/credit, Higgsfield-MCP video is cheaper than the fal benchmark only if a 5s clip costs **< ~5.8 credits**. Phase 0 measures this in one afternoon.
- Refuted — do **not** budget on these numbers seen around the web: "Kling 2.5T = 4 cr/5s @720p, 6 cr @1080p", "plans = 120/800/1800 credits at $9/$31/$59", "concurrency = 2/3/8 by tier". All failed 0-3.
- Throughput sketch: video gen dominates wall-clock (~1–4 min/clip). With ~4-way effective concurrency, ~100 clips ≈ **1–2 hours of generation**, fully overlapped with your review pace — the review-ahead buffer means you swipe continuously while the queue works.

### Open questions carried into Phase 0
1. Actual per-clip credit cost for Kling 2.6 / 3.0 / 3.0 Turbo / Seedance 2.0 (Mini) via MCP, and MCP concurrency/rate-limit behavior.
2. Team-plan Character feature caps (individual tiers cap at 48/320/720 generations).
3. Higgsfield MCP OAuth behavior over multi-hour unattended runs.
4. Kling 2.6/3.0 visual parity with your established 2.5 Turbo look (else fall back to fal/Replicate which still host 2.5 Turbo).

---

## Phase 0 — MEASURED RESULTS (executed 2026-07-03, total spend 23.55 credits ≈ $1.41; full trail in `log.md`)

**Costs (get_cost preflight, reconciled against the transactions ledger):** images — soul_2 0.12, z_image 0.15, gpt_image_2-low 0.5, seedream 1, nano_banana_2 1.5, nano_banana_pro 2 (4K: 4), cinematic_studio_2_5 2. Video — kling2_6 5cr/5s (native 1080p!), kling3_0_turbo 1.5cr/s linear (3–15s), kling3_0 std silent **charged 6.25/5s** (preflight said 7.5 — sound-off discount applies at charge; ledger is ground truth), veo3_1_lite 1cr/s, minimax 1cr/s, seedance_2_0 std 22.5/5s, mini 12.5/5s. `get_cost:true` preflight exists on both generate tools — the app should preflight every job into its cost ledger.

**Decisive identity finding (mid-motion frame comparison, same start_image + prompt):** kling3_0_turbo (no element support) **drifted** — invented a wrong back-of-head during a turn; kling2_6 held moderately; kling3_0 with `<<<element_id>>>` in the video prompt **held identity perfectly**. → **Workhorse: `kling3_0` std, sound off, with element tags in every character-shot video prompt (6.25cr/5s — also cheaper than Turbo).** Element tags in video prompts are the default, not a fallback.

**Elements: fully validated** — element-in-image-prompt ✓ (reference_elements injected, identity held in stills), two-element shot ✓, promote-generation-to-element via image_job id ✓ (instant), element-in-video-prompt on kling3_0 ✓. Naming remap confirmed: requesting `nano_banana_2` routes to internal `nano_banana_flash` (= Nano Banana 2, 1.5cr).

**Aligner:** ctc-forced-aligner **rejected** (wheel build fails on Windows without MSVC). **stable-ts is the verified primary**: clean pip install, true `align()` of known script text, ~15 sec-of-audio/sec on CPU (10-min VO ≈ 40s), per-line timestamps + pause detection working (`phase0/alignment.json`).

**Export:** FFmpeg 8.1.1 + h264_nvenc already installed; full chain (NVENC trim/normalize→1080p30 CFR → concat -c copy → VO mux) ran in **1.9s** for 2 clips → ~100 clips ≈ 1.5–2 min.

**Throughput:** 6 simultaneous jobs accepted with zero throttling; videos processed in parallel (turbo/2.6 ≈ 2 min, kling3_0 std ≈ 4.5 min). Balance 2,048.58 → 2,025.03 (Team plan) ≈ **~2.5 videos' worth of video-gen credits remaining** at kling3_0 rates.

**Still open:** CLI needs one interactive `higgsfield auth login` (then it's a deterministic headless path: `higgsfield generate create <model> --json --wait`, media flags auto-upload local files); MCP OAuth longevity over multi-hour runs; whether the platform API/CLI honors `<<<element_id>>>` placeholders (if not: adapters pass element reference images explicitly via image roles); Soul training + Team character caps (optional — Elements-first).

---

## Part 2 — Target Architecture

```
┌──────────────────────────── Windows laptop (all local) ────────────────────────────┐
│                                                                                    │
│  ┌────────────┐   ┌──────────────────────────────────────────────┐                 │
│  │ Ingest      │   │ Orchestrator (Node/TS service)               │                 │
│  │ script.txt  │──▶│ · SQLite: shots, jobs, EDL, costs            │                 │
│  │ voiceover   │   │ · State machine + review-ahead buffer (N=5)  │                 │
│  │ ctc-forced- │   │ · Provider interface:                        │                 │
│  │ aligner /   │   │     ① Higgsfield MCP client (direct, OAuth)  │──▶ mcp.higgsfield.ai
│  │ WhisperX    │   │     ② fal.ai adapter (FAL_KEY)   [fallback]  │──▶ fal queue    │
│  └────────────┘   │     ③ Replicate adapter          [fallback]  │──▶ replicate    │
│                    │ · Claude Agent SDK (Sonnet): image prompts,  │                 │
│                    │   animation prompts, edit-instruction loops  │                 │
│                    │ · FFmpeg workers: download, trim→30fps CFR,  │                 │
│                    │   NVENC export, concat, VO mux               │                 │
│                    └───────────────┬──────────────────────────────┘                 │
│                                    │ Fastify + WebSocket (0.0.0.0:PORT)             │
│                    ┌───────────────┴──────────────┐                                 │
│                    │ Web UI (React, one codebase)  │                                 │
│                    │ · Swipe review (PWA, mobile)  │◀──── Android phone (same Wi-Fi) │
│                    │ · Timeline + preview (A/B     │                                 │
│                    │   <video> swap + audio clock) │                                 │
│                    │ · Redo-from-timeline dialog   │                                 │
│                    │ · Export panel + cost meter   │                                 │
│                    └──────────────────────────────┘                                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Multi-account support (user requirement, 2026-07-03):** the user has many Higgsfield accounts and needs one-click switching with every account's auth kept saved. Verified mechanism: the CLI binary honors **`HIGGSFIELD_CREDENTIALS_PATH`** (env-var override for its `credentials.json`, normally at `~/.config/higgsfield/credentials.json`). Design: an **AccountManager** stores per-account credential files under `app/accounts/<name>/credentials.json`; every CLI invocation gets `HIGGSFIELD_CREDENTIALS_PATH` set to the active account's file — no swapping, no races, and different jobs can run under different accounts concurrently. "Add account" = run `higgsfield auth login` with the env var pointed at a fresh path (interactive once per account; a device-auth flow exists per `HIGGSFIELD_DEVICE_AUTH_URL`). Per-account balance shown via `higgsfield account status` under each profile; every cost-ledger entry is tagged with the account. UI: account switcher in the desktop top bar and mobile header (avatar/name + balance chip + add-account). Note: the MCP connector surface stays single-account — multi-account rides the CLI/REST adapters. Empirical confirmation of the env var's behavior happens at first login.

Per-shot flow: align → line list → (Claude) image prompt ×5-line batches, auto-tagged with `<<<element_id>>>` for the characters/locations/props in each line → Element-compatible image model (Nano Banana Pro / Cinema Studio 2.5) → **swipe** → right: (Claude) animation prompt (+ element tags on Kling 3.0/Seedance 2.0 when needed) → `start_image` video → auto-trim to line duration → placed on EDL · left: **Edit** (image + instructions → Claude → image-to-image with reference) or **Redo** (fresh prompt) → back to review. Timeline redo: same start_image + new animation prompt → replace clip. Project setup: script parse → element registry (create/select Elements per recurring entity; `@name` autocomplete in all prompt dialogs maps to element IDs).

---

## Part 3 — Phased Build Plan

### Phase 0 — Calibration & de-risking (1–2 days, no code beyond scripts)
1. Confirm MCP headless: `claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp`, auth once, then drive `generate_image`/`generate_video` from a `claude -p` run and from a raw `@modelcontextprotocol/sdk` client reusing the stored token.
2. **Measure real credit costs**: `balance` → 1 test clip each on `kling3_0_turbo` (720p/1080p, 5s), `kling2_6`, `seedance_2_0_mini`, `seedance_2_0`; `balance` again. Build the cost sheet; compare against the $0.35/5s fal benchmark (breakeven ≈ 5.8 credits).
3. **Quality bake-off**: same start image + same animation prompt across those models vs. a fal Kling 2.5 Turbo reference clip. Pick the workhorse model.
4. **Elements calibration (primary consistency path):** create Elements for a test character, location, and prop; generate stills across the Element-compatible image models (resolve the real machine names for Nano Banana Pro vs 2 empirically — the Elements tool and `models_explore` disagree on IDs) and measure per-image credits; test `<<<element_id>>>` in video prompts (Kling 3.0 / Seedance 2.0), including a two-element shot; test promoting an approved generation to an Element via its `image_job` id. Check identity hold across 10 varied scenes. Optional comparison: train one Soul (~10 min) and A/B face fidelity for hero close-ups.
5. Install `ctc-forced-aligner` (+ WhisperX int8 as cross-check); align one real script+VO pair; eyeball cut points against the waveform.
6. Probe MCP concurrency: submit 4–6 jobs at once, observe queuing/429s; note OAuth behavior after a few hours idle.
   **Exit criteria:** chosen video model, measured ¢/clip, alignment working, Soul verified — or a decision to route video through fal/Replicate.

### Phase 1 — Headless pipeline core (week 1)
- Node/TS project: SQLite schema (projects, shots, jobs, EDL, cost ledger, **element registry**), alignment ingest (spawn Python aligner, parse word timestamps → lines + pauses), script-parse step (Claude proposes recurring characters/locations/props → user confirms → Elements created/linked), Claude Agent SDK prompt generation (5-line batches, style-bible + per-line `<<<element_id>>>` tagging), provider interface with the Higgsfield MCP client, download manager.
- CLI end-to-end in **auto-approve mode**: script + VO in → all images → all videos → files on disk + EDL rows. Proves the whole machine before any UI exists.

### Phase 2 — Review app (week 2)
- **AccountManager**: per-account credential files + `HIGGSFIELD_CREDENTIALS_PATH` injection in the CLI adapter, add-account login flow, per-account balance polling, account-tagged cost ledger, and the top-bar/mobile account switcher.
- Fastify + WebSocket + React (Vite). Swipe cards (image, its line, prompt): right = approve (queues animation prompt + video), left = Edit / Redo dialogs. **`@`-mention autocomplete in every prompt box** (Edit, Redo, timeline-redo) resolving element names → `<<<element_id>>>`, plus a "promote this image to Element" action on approved cards. Review-ahead buffer keeps 5 cards ready; approving card k auto-starts image k+5 — the PRD's "never wait" requirement.
- Mobile-first PWA styling; test from the phone over LAN day one (it's the same URL).

### Phase 3 — Timeline & export (week 3)
- Timeline strip (clips scaled to duration, VO waveform underneath), A/B `<video>` preview locked to the `<audio>` clock, per-clip trim nudge, **Redo-animation dialog** (new prompt + same start_image → regenerate → swap in).
- Export: parallel NVENC trim/normalize (30fps CFR, 1920×1080) → concat `-c copy` → VO mux → final MP4. Target: <5 min for a 10-min video.

### Phase 4 — Hardening & scale (week 4)
- Crash-resume from SQLite; retry with backoff; `nsfw`/moderation auto-retry with prompt sanitization; adaptive concurrency (start 2, raise until throttled).
- fal/Replicate adapters live behind the provider flag (per-project or automatic on repeated MCP failure); cost meter in the UI via `balance` polling + per-job ledger.
- Nice-to-haves: batch multi-project queue, Topaz/`upscale_video` pass for hero shots, export presets.

---

## Part 4 — Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Higgsfield per-clip video credits cost more than fal's $0.07/sec | Unknown (the one number research couldn't verify) | Phase 0 measurement **before** building against it; provider interface makes switching a config flag |
| MCP OAuth expires mid-run / unattended limits | Medium | Detect 401 → pause queue → surface re-auth prompt in UI; queue state survives; API-key fallbacks (fal/Replicate) unaffected |
| Kling 2.6/3.0 doesn't match your 2.5 Turbo look | Medium | Phase 0 bake-off; fal/Replicate still host 2.5 Turbo Pro at verified $0.35/5s |
| MCP catalog drift (launched ~Apr 2026, fast-moving) | High over months | Model registry in config, refreshed via `models_explore` at project start — never hardcode model IDs |
| Character drift across 100+ shots | Medium | Elements (`<<<element_id>>>`) in every image prompt + style-bible wardrobe lock; element tags again in video prompts (Kling 3.0/Seedance 2.0) for stubborn shots; optional Soul for hero close-ups; Edit loop as the manual escape hatch |
| Preview stutter | Low | Cuts-only A/B `<video>` swap + 30fps CFR normalization at ingest; NVDEC handles this trivially on the 4050 |
| 6GB VRAM pressure during alignment | Low | ctc-forced-aligner is ~0.6GB; WhisperX int8 batch 4 ≈ 4.5GB, run sequentially, never during preview/export |
| Moderation false-positives (`nsfw` status) | Medium at volume | Auto-rewrite prompt via Claude and retry once; then surface to review UI |

---

## Refuted claims (do not reuse these numbers)
1. "Higgsfield Kling 2.5T = 4 credits/5s @720p, 6 @1080p (→ 400–600 credits/video)" — **0-3**.
2. "Plans = Basic $9/120cr, Pro $31/800cr, Max $59/1800cr" — **0-3**.
3. "Concurrency = 2/3/8 video jobs by tier" — **0-3**.
4. "ctc-forced-aligner uses 5× less memory than TorchAudio" — **0-3** (tool itself is fine).

## Key sources
[higgsfield.ai/mcp](https://higgsfield.ai/mcp) · [higgsfield.ai/pricing](https://higgsfield.ai/pricing) (JS-rendered — verify in a real browser) · [docs.higgsfield.ai](https://docs.higgsfield.ai/docs/guides/video.md) + [higgsfield-js](https://github.com/higgsfield-ai/higgsfield-js) · [fal Kling 2.5T Pro](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video) · [Replicate kwaivgi/kling-v2.5-turbo-pro](https://replicate.com/kwaivgi/kling-v2.5-turbo-pro) · [kling.ai/dev/pricing](https://kling.ai/dev/pricing) (blocks non-browser fetches) · [WhisperX](https://github.com/m-bain/whisperX) · [ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner) · [Claude Code headless](https://code.claude.com/docs/en/headless) · [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) · [react-video-editor](https://github.com/designcombo/react-video-editor) · [omniclip](https://github.com/omni-media/omniclip). All pricing/catalog figures are snapshots of **2026-07-03** — re-verify at build time.
