# Director's Flick — Team Resume / Onboarding

> Read this first. It is the fast path to full context for ANY agent (or human)
> resuming work on this repo. Written at wind-down on 2026-07-04 after the
> v0.1.0 → v0.1.2 build campaign. Orchestrator: Fable (Claude Fable 5).

---

## 1. What this product is

**Director's Flick** — a local Windows app that automates the owner's AI-video
production workflow:

> owner's script + owner's own voiceover (NEVER TTS — the owner records their
> own VO) → stable-ts forced alignment → per-line/per-phrase shots → image per
> shot via Higgsfield (element-tagged for character consistency) → swipe review
> (approve / edit / redo) → image-to-video animation → auto-cut timeline
> synced to the VO → 1080p/30 NVENC export (+ SRT sidecar).

Owner: sole user, produces multiple ~10-minute narrative videos/month
(documentary style, Hinglish narration, recurring characters via Higgsfield
Elements).

## 2. State at wind-down

- **Releases**: `v0.1.0` (feature-complete), `v0.1.1` (multipart upload OOM
  fix), `v0.1.2` (JSON-path 20MB guardrail). All tags on origin.
- **Tests**: 346/346 green (hermetic; zero network/credits), app+ui tsc clean.
- **Verified**: production build 14/14 UI journey; cold-clone launcher ~18s;
  100-shot scale test GO (flat memory, 39s export); crash-recovery = no double
  spend; alignment survived 11-class adversarial input attack.
- **Owner-directed work at shutdown**:
  - T-89 DONE — owner's 23-rule "Documentary Image Prompt Writer" is the LLM
    engine's system prompt (`app/prompts/documentary-image-writer.md`,
    OWNER-AUTHORED, READ-ONLY) with Rule 3/12 post-checks + identity guard.
  - T-88 — phrase-level shot segmentation (sentence split → maxShotSeconds cap
    → Hinglish phrase boundaries → runt merge). Status: see BOARD.md row.
- **Next milestone (owner's call)**: first real-credit pilot —
  `docs/pilot-runbook.md`, ~20 shots ≈ 155 cr (~$9.30), review deck ON,
  auto-approve OFF.

## 3. Repo map (read in this order)

| Path | What |
|---|---|
| `orchestration/BOARD.md` | Task board: protocol rules 1–12, all task rows T-01…T-89, result notes. THE coordination ledger. |
| `log.md` | Append-only action log, entries [1]–[115+]. Convention: log BEFORE acting, under your own `## Session:` heading. |
| `research-and-plan.md` | Research, Phase-0 MEASURED costs, architecture, phased plan. |
| `docs/pilot-runbook.md` | Operator procedure for the real-credit pilot (proven executable by dry-run). |
| `docs/api.md` | REST/WS API reference (v3+). Routes are **singular** `/api/project/:name/...` for per-project; plural `/api/projects` only for create/list. |
| `docs/user-guide.md` | End-user walkthrough. |
| `app/ARCHITECTURE.md` | Backend architecture + review-verb contract. |
| `app/src/types.ts` | **Contracts (Fable-owned)** — PipelineConfig, ShotQueue states, ProviderName ('mock'\|'higgsfield-cli'\|'fal'\|'replicate'), promptBackend/llmModel/maxShotSeconds. |
| `app/src/` | queue.ts (state machine), align.ts (stable-ts bridge + input hardening), media.ts (ffmpeg), server.ts (Express+WS+static), cli.ts, accounts.ts (multi-account), cost-summary.ts, srt.ts, prompts.ts / prompts-llm.ts, providers/ |
| `app/prompts/documentary-image-writer.md` | Owner-authored image-prompt spec. READ-ONLY without owner approval. |
| `ui/src/` | React app: App.tsx (chrome+AccountChip), pages/ (Setup, ReviewPage, TimelinePage, MobileReviewPage, SettingsPage), player/ (A/B gapless engine + waveform), useSwipe.ts |
| `design/` | tokens.css, mockups, design-spec.md (dark #0A0A0B + lime #B9FF3B, Higgsfield-like). |
| `scripts/start-directors-flick.ps1` | One-command production launcher (deps→build→serve→open; -Port -NoBrowser). |
| `orchestration/bootstrap-*.md` | Per-agent inbox files (sonnet, fable2, opus, flash, antigravity). Task delivery happens HERE + board rows. |
| `orchestration/.fable-state.json` | Orchestrator sweep state (last_seen_commit, pending). |
| `phase0/` | Calibration evidence. Some media is CONSUMED by MockProvider (PHASE0_SAMPLE_DIR) — audit refs before pruning. |

## 4. Team & how to restart it

Roster (paste each agent's `orchestration/bootstrap-<name>.md` into its terminal):

| Agent | Model | Role / territory |
|---|---|---|
| **Fable** | Claude Fable 5 (this session's orchestrator) | Contracts (types.ts, ARCHITECTURE.md), board arbitration, acceptance reviews, credit spending, git push authority, release tag pushes. |
| **Fable-2** | Claude Fable 5 (2nd terminal) | Hard problems + frontend owner (`ui/**`, `design/**`). |
| **Sonnet** | Claude Sonnet 5 | Backend `app/src/**`, tests, docs. |
| **Opus** | Claude Opus 4.8 | Per-task leases; hardening/e2e/verification/releases (cuts tags locally, Fable pushes). |
| **Flash** | Gemini 3.5 Flash | Tests + docs (OFFLINE at wind-down — quota). |
| **AGV** | Antigravity Gemini 3.1 Pro | Frontend/design support (OFFLINE at wind-down — quota). |

Coordination model: file-based via git on ONE shared checkout. Board rows =
tasks; `@agent` notes = messages; commit prefixes `[fable] [fable2] [sonnet]
[opus] [flash] [agv]`; Fable runs an automated monitor (git poll + board grep)
and accepts every task against evidence (suite/tsc/live repro) before closing.

**Protocol rules live at the top of BOARD.md.** The ones that exist because
something burned us:
- **R9**: stage EXPLICIT paths only; never `git add -A`/`.` (shared worktree). Fable uses `git commit --only <paths>` when others have staged files.
- **R10**: tests bind ephemeral ports; announce manual servers on non-default ports.
- **R11**: heartbeat commit every ~10 min during long runs (silence reads as a stall).
- **R12**: release verification runs against the TAGGED COMMIT (`git show tag:file`), two independent checks — never the working tree (shared-checkout skew shipped a wrong CHANGELOG claim once).
- Bootstrap-file edits: agents restructure their own inboxes — pattern-match
  replacements can silently no-op (bit us twice). Verify the write landed.
- Agents PULL before polling (stale-checkout idle notes bit us twice).

## 5. Operational knowledge (hard-won)

- **Server picks up code only on restart.** After any backend update: restart
  via the launcher. Version-skew symptom: new UI + old server = misleading
  400s (e.g. "name must be non-empty" on a valid multipart create).
- **UI is served from `ui/dist`** (static) in production mode — rebuild
  (`npx vite build` in ui/) after UI changes or the browser gets stale code.
- Costs (Phase-0 MEASURED): nano_banana_2 image 1.5cr; kling3_0 std silent
  1.25cr/s (6.25cr/5s) ⇒ ~7.75cr per 5s shot; soul_2 0.12cr; $0.06/cr.
  Credits vs USD are NEVER summed (unit-aware ledger everywhere).
- Multi-account: `higgsfield auth login` per account via
  `HIGGSFIELD_CREDENTIALS_PATH`; CLI `accounts --add <name>`; UI chip has
  add/switch. Owner's accounts: MCP=Team workspace; CLI=capitalstory Max.
- **Element identity rule** (quality-critical, T-08 lesson): element tags in
  prompts, NEVER physical descriptions of tagged characters — the LLM engine
  enforces this with a post-check + template fallback.
- Uploads: multipart streaming (client FormData → multer disk). The base64
  JSON path survives only for ≤20MB (413 above). Never buffer files in RAM.
- Windows box: paths contain a space ("Video Automation") — quote everything;
  spawn with array args; ffmpeg 8.1.1 + h264_nvenc on PATH; python + stable-ts
  installed (ctc-forced-aligner does NOT build on Windows).
- PowerShell traps: backtick-`u` in double-quoted strings is a Unicode escape
  (use single-quoted here-strings); `Add-Content` to a file without trailing
  newline mangles the last line.

## 6. Deferred / open items at wind-down

1. **Real-credit pilot** — the next milestone, owner's go pending
   (docs/pilot-runbook.md; validate concurrency 4 vs 6 under real latency
   during it — T-74 finding).
2. T-88 phrase segmentation — if not accepted at shutdown, finish + accept
   first (owner's L01/L03 worked example in log [113] is the fixture), then
   owner re-runs alignment on their `sugar_cosmetics`-era project.
3. Tinder-style swipe physics (rotation-while-drag, velocity fling,
   spring-back, stamps) — offered to owner, not yet ordered.
4. phase0 tracked media (~31MB) — mock-consumed, stays; revisit git-lfs or a
   fixtures move post-pilot.
5. Gemini agents (Flash/AGV) — re-enable by refreshing their bootstraps when
   quota returns.
6. Live LLM smoke of prompts-llm.ts with a real ANTHROPIC_API_KEY — never run
   (hermetic-only so far); Fable runs it when a key is provided.

## 7. Quick start (human)

```powershell
powershell -File scripts\start-directors-flick.ps1   # build+serve+open
cd app; npm run cli -- accounts --add main            # Higgsfield login
# create project in UI (script + your VO), review, export — or CLI:
npm run cli -- init my_project --script s.txt --vo vo.wav
```
