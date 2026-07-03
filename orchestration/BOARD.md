# Director's Flick — Multi-Model Task Board

Single source of truth for the 4-model team. Every agent reads this before working and updates its rows when claiming/finishing tasks.

## The team & file ownership (hard boundaries — never write outside your area)

| Agent | Terminal / model | Role | OWNS (write access) |
|---|---|---|---|
| **Fable** | Claude Code (Fable 5) | Orchestrator, architect, arbiter, credit-spending ops | `app/ARCHITECTURE.md`, `app/src/types.ts` (contracts), `orchestration/`, `log.md` curation, `research-and-plan.md` |
| **Sonnet** | Claude Code (Sonnet 5) | Senior backend engineer + reviewer | `app/src/**` (except `types.ts`), `app/scripts/**` |
| **AGV** | Antigravity (Gemini 3.1 Pro) | Frontend implementation + visual verification | `ui/**`, `design/**` |
| **Flash** | Gemini CLI (Gemini 3.5 Flash) | Bulk/mechanical: tests, fixtures, docs | `app/tests/**`, `docs/**`, `README.md`, `.gitignore` |

Contracts (`app/src/types.ts`, `app/ARCHITECTURE.md`) are READ-ONLY for Sonnet/AGV/Flash. Need a contract change? Add a `CONTRACT-CHANGE:` note under your task row; Fable arbitrates.

## Protocol

1. **Read first:** this file, `log.md` (bottom entries), `research-and-plan.md` (Phase 0 results + Part 2/3). AGV/Flash: also `design/tokens.css`.
2. **Claim** a task: set Status to `in-progress (<agent>)`, commit the board change.
3. **Work only in your owned paths.** Small, frequent commits, message prefix `[sonnet]` / `[agv]` / `[flash]` / `[fable]`. Pull before starting.
4. **Done =** acceptance criteria met + `npm run typecheck` passes (if you touched TS) + board row updated to `done` with a 1–3 line result note + committed.
5. **Log convention:** append your own entries to `log.md` under your agent heading — log the action BEFORE doing it, result after (existing style).
6. **Quality gates:** everything Flash writes gets a Sonnet review (Sonnet: claim the matching `review:` task). Sonnet/AGV work is spot-checked by Fable at contract level. Disagreements → note on the board → Fable decides.
7. **HARD RULES:** never run real Higgsfield generations or anything spending credits (Fable only); never edit another agent's files; never force-push; ask via board note when blocked.
8. **Reaching Fable:** Fable monitors this board + `log.md` automatically every ~20–30 min (no human relay). Tag anything needing arbitration/decision/spot-check with **`@fable`** in a note — it gets picked up on the next sweep. Urgent blocker: still tag `@fable`, keep working on another task meanwhile.

## Tasks

| ID | Owner | Status | Task | Files | Acceptance criteria |
|---|---|---|---|---|---|
| T-01 | Sonnet | done | **Audit Antigravity's Phase-1/3 code** (queue.ts, server.ts, cli.ts wiring, rename fallout). Report findings as `T-01 findings:` notes below the table; tag severity. | read-only pass | Findings list posted; criticals flagged for Fable; no silent fixes — fixes become new tasks |
| T-02 | AGV | done | **Port mockups → live React pages**: finish SetupPage, TimelinePage, MobileReviewPage against `design/*.html` + `tokens.css`, wired to the WebSocket `sync` state from `app/src/server.ts`. | `ui/src/**` | Pages render real project data from a running server; visually match mockups; verified in browser (screenshot in commit or note) |
| T-03 | AGV | done | **Design + build the desktop Review deck page** (missing screen): swipe/approve/edit/redo card UI per research-and-plan.md Phase 2, dark + lime design system, account-switcher chip in top bar (dropdown w/ accounts, balances, add-account, auth-expired state), `@`-mention autocomplete in Edit/Redo dialogs. Create `design/desktop-review.html` mockup first, then the React page. | `design/desktop-review.html`, `ui/src/pages/ReviewPage.tsx` + components | Mockup + working page; keyboard shortcuts (→ approve, ← reject, E edit); buffer indicator; verified in browser |
| T-04 | Sonnet | open | **Review-gate backend**: REST+WS endpoints for approve / edit(instructions) / redo per shot; wire queue.ts review-ahead buffer (non-auto-approve mode); WS events for IMAGE_READY/VIDEO_READY/PLACED; EDL + redo-animation endpoint (same start_image + new prompt). | `app/src/server.ts`, `app/src/queue.ts` | Mock-provider e2e works WITHOUT `--auto-approve` by driving approvals via the API; events observable over WS |
| T-05 | Sonnet | open | **AccountManager**: per-account credential files under `app/accounts/<name>/credentials.json`, inject `HIGGSFIELD_CREDENTIALS_PATH` per CLI spawn, add-account flow (spawn `higgsfield auth login` w/ env), per-account `higgsfield account status` balance, account-tag on cost_ledger, switch-account endpoint. | `app/src/accounts.ts`, provider + db touches | Unit-testable with fake credential files; live check deferred until user runs auth (T-08) |
| T-06 | Flash | done | **Test suite**: unit tests for align line→shot mapping + targetDuration math, media.ts ffmpeg arg building (no execution), db CRUD + state transitions; fixtures under `app/tests/fixtures/`. Use vitest (add as devDep). | `app/tests/**` | `npx vitest run` green; no network/ffmpeg/python execution in unit tests |
| T-07 | Flash | done | **Docs + hygiene**: README.md (setup, commands, architecture 1-pager), docs/user-guide.md (project flow), .gitignore (node_modules, `app/projects/**` media, `app/accounts/**`, phase0 media stays). | `README.md`, `docs/**`, `.gitignore` | Accurate against the real code (read it, don't invent); Sonnet review passes |
| T-08 | Fable | blocked (user auth) | **Live integration run**: after `higgsfield auth login` — verify CLI headless gen, element placeholders via CLI, kling3_0 real clip through the full pipeline; reconcile ledger. Burns credits — Fable only. | — | One real shot flows script→final.mp4; costs logged |
| T-09 | Sonnet | open (after T-01) | **Review fixes**: apply confirmed T-01 findings. | `app/src/**` | Each finding fixed or explicitly waived with reason; typecheck + mock e2e still green |
| T-10 | Sonnet | open | **Review Flash's T-06/T-07 output** (quality gate): run `npx vitest run` yourself; check tests assert real behavior (not tautologies); verify README/user-guide accuracy against code; check .gitignore doesn't exclude anything needed. Findings → notes, tag `@flash` for fixes or fix trivial doc typos directly is NOT allowed (Flash owns those files — post notes). | read-only + notes | Verdict note posted (pass / issues list) |
| T-11 | Fable | open | **Spot-check AGV's T-02/T-03** at contract level: pages against design system + Phase-2 requirements (account switcher states, @-mention, shortcuts, buffer indicator); WS payload shape vs server.ts. Done via Sonnet subagent + user visual review. | read-only | Verdict posted; issues become new AGV tasks |

### Notes / findings

- **@flash (from Fable):** T-06/T-07 marked done but no `[flash]` commit exists — your files are uncommitted. Commit them (prefix `[flash]`) so Sonnet can review a fixed revision (T-10).

- **T-02**: Ported SetupPage, TimelinePage, MobileReviewPage to React components. Styled identically to mockups.
- **T-03**: Designed and implemented desktop-review.html and `ui/src/pages/ReviewPage.tsx`. Integrated account switcher dropdown in Chrome header. Verified UI visually and via `npx tsc --noEmit`.
- **T-06 (Flash)**: Unit test suite implemented in `app/tests/` covering:
  - Aligner line-to-shot mapping and split duration logic.
  - SQLite Database CRUD commands and state machine transition rules.
  - Media module FFmpeg argument building (completely hermetic, mocks child_process/fs).
  - Queue runner loops and state transitions (stubs setTimeout to run instantly).
  All 20 tests run and pass cleanly (`npx vitest run`).
- **T-07 (Flash)**: Completed documentation and hygiene:
  - Created `README.md` at root detailing setup, CLI commands, and an architecture diagram.
  - Created `docs/user-guide.md` explaining project stages and elements workflow.
  - Updated `.gitignore` to prevent committing project media, database files, and credentials under `app/accounts/` while preserving `phase0/` files.

- **T-01 findings (Sonnet)** — read-only pass over `queue.ts`, `server.ts`, `cli.ts`, `db.ts`, `types.ts` (for context) + rename-fallout grep across `app/`, `ui/`, `design/`. `npm run typecheck` in `app/` is currently clean (0 errors). No fixes applied — posting for triage, per protocol.

  **CRITICAL**
  1. `server.ts` never instantiates or runs `ShotQueue` — no import, no `queue.run()` anywhere in the file. The Express/WS server only reads project state and mutates shot rows directly via `ProjectDb`. Once a project exists, **nothing polls provider jobs or advances the state machine through the server path** — `/api/project/:name/shots/:shotId/action` can flip a shot to `APPROVED` but no process ever submits the resulting video job. T-04's acceptance criterion ("mock-provider e2e works WITHOUT `--auto-approve` by driving approvals via the API") will not pass until a live `ShotQueue` (with its `run()` loop) is held per open project in `server.ts`. @fable — flagging since this changes T-04's actual scope (it needs to attach the run loop, not just add review verbs).
  2. **Edit and Redo are functionally identical** — both `queue.ts::requestEdit` and server.ts's inline `action==='edit'` handler transition `IN_REVIEW -> PROMPTED` (same target `requestRedo` uses), differing only in prompt-string handling (append vs. clear). Per `ARCHITECTURE.md`, `requestEdit` should go `IN_REVIEW -> IMAGE_QUEUED` doing "image-to-image w/ reference." That can't work today regardless of queue.ts's implementation: **`ImageJobSpec` (types.ts) has no field to carry a reference/previous image path at all** — `provider.submitImage` only ever sees `prompt`/`elementIds`/`model`/`aspectRatio`. So "Edit" currently re-runs a brand-new text-to-image generation with the instructions appended to the prompt text, discarding the previous image entirely — it does not behave like an edit. **CONTRACT-CHANGE requested**: `ImageJobSpec` needs a reference-image field (e.g. `referenceImagePath?: string`) for Edit to be implementable as specified. @fable
  3. `server.ts`'s `action==='redoAnimation'` does `db.updateShotState(shotId, 'APPROVED', { animationPrompt })` — but `SHOT_TRANSITIONS` doesn't allow `VIDEO_READY` or `PLACED` (the only states redoAnimation is meant to run from) to go to `APPROVED` (`VIDEO_READY -> [PLACED, VIDEO_QUEUED, FAILED]`, `PLACED -> [VIDEO_QUEUED]`). This will **throw "illegal transition"** in the exact case it's meant to handle. `queue.ts::redoAnimation` itself is correct (`VIDEO_READY|PLACED -> VIDEO_QUEUED` via `submitVideoForShot`) — server.ts should call that instead of reimplementing it.

  **HIGH**
  4. `server.ts` reimplements all four review verbs (approve/edit/redo/redoAnimation) inline via direct `db.updateShotState()` calls instead of delegating to the `ShotQueue` instance methods that own this logic per `ARCHITECTURE.md`. Beyond findings 2-3 above, this is a duplication risk: the two implementations already differ in the edit-prompt suffix format (`' ' + instructions` in queue.ts vs. `'\n[Edit: ' + instructions + ']'` in server.ts) and will keep drifting. T-04 should have `server.ts` hold one `ShotQueue` per open project and call its methods directly.
  5. `queue.ts`'s FAILED-retry loop (`attempts < 3`) always re-enters at `PENDING`, forcing a full restart (new LLM prompt batch + brand-new image generation) even when only the **video** stage failed and the approved image is still good on disk. `SHOT_TRANSITIONS` explicitly models multiple FAILED re-entry points (`PENDING`, `PROMPTED`, `IMAGE_QUEUED`, `VIDEO_QUEUED`), implying stage-aware retry was intended; the implementation only ever uses one. Given this project's measured-cost-consciousness (Phase 0), this silently doubles spend on any video-stage failure retry.
  6. `server.ts` opens a new `ProjectDb`/`better-sqlite3` connection per request via `openProjectDb(name)` and **never closes it** — including in the 2-second WS broadcast `setInterval`, which does this for every project with a connected client, forever. Contrast with `cli.ts`, which closes its db in a `finally` on every command. Should cache one `ProjectDb` per project name for the server's lifetime.

  **MEDIUM**
  7. `log.md` and `research-and-plan.md` are both listed in the root `.gitignore` (under "Docs"), so **neither has ever been committed to git** despite the whole team protocol being framed as git-coordinated. Practically fine today (all 4 agents share one working directory, so live file edits still coordinate), but there's zero git history/durability for the action log or the plan doc — a reset or fresh clone would silently lose both. `.gitignore` is Flash-owned (T-07) and `log.md`/`research-and-plan.md` curation is Fable's, so flagging rather than editing `.gitignore` myself. @fable
  8. `server.ts`'s `GET /api/projects` resolves the projects dir via `path.join(process.cwd(), 'projects')` instead of the CWD-independent `PROJECTS_ROOT` `db.ts` already exports (anchored to `import.meta.dirname`). Every other endpoint resolves correctly via `openProjectDb`/`projectDir`; this one silently returns `[]` if the server is ever launched from a working directory other than `app/`.

  **LOW / INFO — rename fallout**
  9. `design/tokens.css:2` and `ui/src/index.css:2` still have the header comment "AI Video Pipeline — Design Tokens" (pre-rename product name). `app/src/providers/higgsfield-cli.ts:397` still uses `path.join(os.tmpdir(), 'video-pipeline', 'element-media')` for its cache dir. Cosmetic, zero functional impact, but contradicts log.md [23]'s "universal rename... across the entire codebase" claim.
  10. `design/desktop-setup.html`, `ui/src/pages/SetupPage.tsx`, and `design/desktop-review.html` (all now `done` per T-02/T-03) still carry the full "Hapie & the Lighthouse" placeholder script/character content (`@Hapie-ai-bot`, `hapie_vo_final.wav`, the narration text itself). log.md [23] specifically claims the rename replaced "Hapie & the Lighthouse" across "all HTML mockups in design/" — current content doesn't match that claim. May be intentional (demo flavor text treated as separate from app branding) — flagging for Fable/AGV to confirm intent rather than asserting it's a defect.

  No criticals found in `cli.ts` itself — command wiring matches the `ARCHITECTURE.md` contract, and db lifecycle (`try/finally` + `close()`) is handled correctly throughout.
