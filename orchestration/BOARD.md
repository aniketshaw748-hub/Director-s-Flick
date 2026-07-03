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
| T-01 | Sonnet | in-progress (sonnet) | **Audit Antigravity's Phase-1/3 code** (queue.ts, server.ts, cli.ts wiring, rename fallout). Report findings as `T-01 findings:` notes below the table; tag severity. | read-only pass | Findings list posted; criticals flagged for Fable; no silent fixes — fixes become new tasks |
| T-02 | AGV | done | **Port mockups → live React pages**: finish SetupPage, TimelinePage, MobileReviewPage against `design/*.html` + `tokens.css`, wired to the WebSocket `sync` state from `app/src/server.ts`. | `ui/src/**` | Pages render real project data from a running server; visually match mockups; verified in browser (screenshot in commit or note) |
| T-03 | AGV | done | **Design + build the desktop Review deck page** (missing screen): swipe/approve/edit/redo card UI per research-and-plan.md Phase 2, dark + lime design system, account-switcher chip in top bar (dropdown w/ accounts, balances, add-account, auth-expired state), `@`-mention autocomplete in Edit/Redo dialogs. Create `design/desktop-review.html` mockup first, then the React page. | `design/desktop-review.html`, `ui/src/pages/ReviewPage.tsx` + components | Mockup + working page; keyboard shortcuts (→ approve, ← reject, E edit); buffer indicator; verified in browser |
| T-04 | Sonnet | open | **Review-gate backend**: REST+WS endpoints for approve / edit(instructions) / redo per shot; wire queue.ts review-ahead buffer (non-auto-approve mode); WS events for IMAGE_READY/VIDEO_READY/PLACED; EDL + redo-animation endpoint (same start_image + new prompt). | `app/src/server.ts`, `app/src/queue.ts` | Mock-provider e2e works WITHOUT `--auto-approve` by driving approvals via the API; events observable over WS |
| T-05 | Sonnet | open | **AccountManager**: per-account credential files under `app/accounts/<name>/credentials.json`, inject `HIGGSFIELD_CREDENTIALS_PATH` per CLI spawn, add-account flow (spawn `higgsfield auth login` w/ env), per-account `higgsfield account status` balance, account-tag on cost_ledger, switch-account endpoint. | `app/src/accounts.ts`, provider + db touches | Unit-testable with fake credential files; live check deferred until user runs auth (T-08) |
| T-06 | Flash | done | **Test suite**: unit tests for align line→shot mapping + targetDuration math, media.ts ffmpeg arg building (no execution), db CRUD + state transitions; fixtures under `app/tests/fixtures/`. Use vitest (add as devDep). | `app/tests/**` | `npx vitest run` green; no network/ffmpeg/python execution in unit tests |
| T-07 | Flash | done | **Docs + hygiene**: README.md (setup, commands, architecture 1-pager), docs/user-guide.md (project flow), .gitignore (node_modules, `app/projects/**` media, `app/accounts/**`, phase0 media stays). | `README.md`, `docs/**`, `.gitignore` | Accurate against the real code (read it, don't invent); Sonnet review passes |
| T-08 | Fable | blocked (user auth) | **Live integration run**: after `higgsfield auth login` — verify CLI headless gen, element placeholders via CLI, kling3_0 real clip through the full pipeline; reconcile ledger. Burns credits — Fable only. | — | One real shot flows script→final.mp4; costs logged |
| T-09 | Sonnet | open (after T-01) | **Review fixes**: apply confirmed T-01 findings. | `app/src/**` | Each finding fixed or explicitly waived with reason; typecheck + mock e2e still green |

### Notes / findings

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
