# Director's Flick — First Real-Credit Pilot Runbook

**Audience:** the product owner running the first pilot that spends real Higgsfield credits.
**Status gate:** T-74 (100-shot scale test) returned **GO on scale grounds** — the pipeline places 100/100 shots, EDL/export are correct, memory is flat, crash-resume is proven (T-63). This runbook is the executable procedure for turning that GO into a real, reviewed video.

Everything below is verified against the current `app/src/cli.ts` / `server.ts` / `config.ts` (2026-07-04). Every command is run from the **`app/` directory** and invoked as `npm run cli -- <command>` (that maps to `tsx src/cli.ts <command>`). Where a step is a web-UI action it says **[UI]**.

> **Golden rule:** the review deck is the whole point of the pilot. Do **not** pass `--auto-approve` — you want to inspect every image before it becomes a (costly) video.

---

## 0. Prerequisites (one-time)

| Requirement | Check |
|---|---|
| Node.js 22+ | `node --version` |
| FFmpeg + NVENC | `ffmpeg -version` (Phase 0 confirmed 8.1.1 + `h264_nvenc`) |
| Higgsfield CLI installed | `higgsfield --version` (installed globally via npm) |
| Higgsfield account authed | one interactive `higgsfield auth login` per account — done via `accounts --add` below |
| Credits available | Team plan, ~2,025 cr after Phase 0 — verified live in step 1 |

If any prerequisite is missing, stop and install it first. (Note: the `scripts/start-directors-flick.ps1` launcher checks node + ffmpeg but **not** Python; the pilot pipeline here does not need Python because alignment inputs are already produced — see step 3.)

---

## 1. Preflight checklist

### 1.1 Register + verify the Higgsfield account
```bash
# Register an account — spawns an interactive `higgsfield auth login` scoped to it.
npm run cli -- accounts --add pilot

# Verify auth + LIVE balance for every registered account (spawns the CLI).
npm run cli -- accounts --status
```
Confirm the output shows `pilot: <N> credits` (authenticated). **Record the starting balance** — you will reconcile against it after the run. Credentials are stored per-account under `app/accounts/<name>/`.

### 1.2 Choose the account
The pilot account is selected at generation time: **[UI]** the account switcher (desktop top bar / mobile sheet), or per CLI run via `--account pilot`. Decide now which account funds this pilot.

### 1.3 Register Elements (identity — do this BEFORE generating)
Consistency is **Elements-first**. Every recurring character/location/prop must be a registered Higgsfield Element so its `<<<element_id>>>` placeholder carries identity (never physically re-describe an element-tagged subject — that caused the T-08 wrong-robot regression).

Get each Element's UUID from Higgsfield (`show_reference_elements`, or `@name` in the Higgsfield web UI), then:
```bash
# Repeatable; category is one of: character | location | prop
npm run cli -- elements <project> --add "<uuid>:Hapie:character"
npm run cli -- elements <project> --add "<uuid>:Lighthouse:location"
# List to confirm:
npm run cli -- elements <project>
```
(You can also register elements inline on `run`/`serve` via config, but the explicit `elements --add` is the clearest audit trail.)

### 1.4 Set the style bible, prompt backend, provider, and models
Defaults (`app/src/types.ts` → `DEFAULT_CONFIG`): provider `mock`, image `nano_banana_2`, video `kling3_0` mode `std`, `soundOff` true, `aspectRatio` `16:9`, `bufferSize` 5, `concurrency` 4, `elementsViaPlaceholders` true, `styleBible` `''`, `promptBackend` `template`.

For the pilot you must change **provider → `higgsfield-cli`** and set a **style bible**. Two ways:

- **[UI] Settings page** — PATCHes the project config. The Settings page can set: `provider`, `imageProvider`, `videoProvider`, `models` (`image`/`video`/`videoMode`), `styleBible`, `accountName`, `promptBackend`, `llmModel`. (It cannot set `concurrency` — see step 8.)
- **`app/config.json`** — a global overrides file (create it if absent). Example for the pilot:
  ```json
  {
    "provider": "higgsfield-cli",
    "models": { "image": "nano_banana_2", "video": "kling3_0", "videoMode": "std" },
    "styleBible": "Painterly cinematic realism; muted teal shadows, warm amber key light; 35mm.",
    "promptBackend": "template",
    "soundOff": true,
    "aspectRatio": "16:9",
    "concurrency": 4
  }
  ```
  Config precedence (low→high): `DEFAULT_CONFIG` → `app/config.json` → the project's saved config → CLI flags.

> **promptBackend note:** `template` (default) is deterministic and free. `llm` generates prompts via the Anthropic API and needs `ANTHROPIC_API_KEY` (it falls back to `template` if the key is absent). `llm` spends Anthropic dollars per prompt — only enable it deliberately.

**Preflight checklist — all must be true before spending a credit:**
- [ ] `accounts --status` shows the pilot account authed with a known balance
- [ ] All recurring Elements registered (`elements <project>` lists them)
- [ ] `provider = higgsfield-cli`, image `nano_banana_2`, video `kling3_0`/`std`
- [ ] Style bible set (non-empty)
- [ ] `promptBackend` decided (`template` unless you intend to spend Anthropic $)
- [ ] Starting credit balance recorded

---

## 2. Cost — measured rates and pilot budget

Rates are the Phase 0 ledger-ground-truth values (`app/src/providers/mock.ts` → `measuredPreflightCredits`; `poll().creditsCharged` is the real post-hoc charge):

| Item | Model | Measured rate |
|---|---|---|
| Image | `nano_banana_2` | **1.5 cr/image** (routes to `nano_banana_flash`, same price) |
| Video | `kling3_0` std, sound-off | **1.25 cr/second** → **6.25 cr / 5s**, 12.5 cr / 10s |

**Per shot** = 1 image + 1 clip. Clip length = `clamp(ceil(targetDuration), 3, 15)` seconds. At a 5-second clip: **1.5 + 6.25 = 7.75 cr/shot**.

| Pilot size | Images (1.5) | Video (6.25 @5s) | Subtotal | +25% review-redo buffer |
|---|---|---|---|---|
| 5 shots | 7.5 | 31.25 | 38.75 cr | ~48 cr |
| 10 shots | 15 | 62.5 | 77.5 cr | ~97 cr |
| 20 shots | 30 | 125 | 155 cr | ~194 cr |
| 50 shots | 75 | 312.5 | 387.5 cr | ~484 cr |
| 100 shots | 150 | 625 | 775 cr | ~969 cr |

Each **redo** during review costs again: image redo +1.5 cr, video redo +6.25 cr — hence the buffer. Against a ~2,025 cr balance, a **20-shot first pilot (~155–195 cr, <10% of balance)** is the recommended starting size; scale up only after reconciling.

**Wall-clock:** T-74 measured the *mock* pipeline (instant generation): queue overhead is tick-bound at ~2 s/loop-tick (≈110 s of pure overhead to place 100 shots) and export is ~0.39 s/clip on tiny 320×240 clips (≈39 s for 100). Under **real credits the dominant term is provider latency**, which the mock could not measure — expect tens of seconds per image and up to minutes per video clip. **Measuring real per-job latency is an explicit pilot goal** (T-74 finding). Real 1080p NVENC export will also be slower per clip than the 0.39 s tiny-clip figure.

---

## 3. Create the project and plan shots

Inputs: a narration script `.txt` and a voiceover `.wav`.
```bash
npm run cli -- init <project> --script path\to\script.txt --vo path\to\vo.wav
npm run cli -- align <project>     # aligns VO->script, applies the timeline rule, plans shots into the db
npm run cli -- status <project>    # confirm shots are planned (state=PENDING), 0 credits so far
```
`align` produces `app/projects/<project>/alignment.json` and the shot plan. No credits spent yet.

---

## 4. Generate + review (the pilot core — server-driven)

Because review is the point, drive generation through the **web UI**, whose review-gate loop stops each shot at `IN_REVIEW` for you to approve. (`cli run --provider higgsfield-cli` *without* `--auto-approve` runs an open-ended review-gate loop that has no CLI approval path — it is meant to be driven by the UI, so use `serve`.)

```bash
npm run cli -- serve --port 4000
```
Then **[UI]** open `http://localhost:4000`:
1. Confirm the account switcher shows the **pilot** account (its credentials fund every job).
2. Confirm Settings shows `provider = higgsfield-cli`, models `nano_banana_2` / `kling3_0`/`std`, and your style bible.
3. The review-gate loop auto-starts: images generate up to the `bufferSize` (5) buffer.
4. **Review each shot in the deck** — per shot you can:
   - **approve** → the shot proceeds to video generation,
   - **edit** (adjust instructions), **redo** (regenerate the image, optional new prompt), or **redoAnimation** (regenerate the video).
   (These map to `POST /api/project/:name/shots/:shotId/action`.)
5. Approved images → `kling3_0` video jobs → `VIDEO_READY` → auto-placed into the EDL.

Do **not** enable auto-approve for the pilot.

---

## 5. Monitor spend continuously

- **[UI]** the cost-meter/cost panel (polls the account balance) while jobs run.
- CLI, any time (read-only):
  ```bash
  npm run cli -- status <project>   # shots by state, open jobs, running credit total
  npm run cli -- cost   <project>   # full ledger dump + totals, unit-aware (credits vs usd)
  ```
- **Reconcile** at the end: `cost <project>` total vs. `accounts --status` balance delta (starting − ending), and cross-check against the Higgsfield dashboard transactions. The ledger is account-tagged; `poll().creditsCharged` (not the preflight estimate) is ground truth. Any mismatch → stop and investigate before scaling.

---

## 6. Abort / resume (safe — proven by T-63)

- **Abort:** stop the server (Ctrl-C, or **[UI]**/`POST /api/project/:name/stop`). In-flight provider jobs already submitted will still be charged when they complete; no *new* jobs are submitted after stop.
- **Resume:** just start `serve` again (or `npm run cli -- run <project>`). The queue rebuilds from `listShots()` + `listOpenJobs()` and continues. **Crash-recovery is proven (T-63): resume causes no double image/video submission and no phantom ledger charges** — an already-queued shot is polled, never re-submitted.

---

## 7. Export

Via **[UI]** export, or CLI:
```bash
npm run cli -- export <project> --srt      # EDL -> trim -> concat -> VO mux -> final.mp4, + a per-line .srt sidecar
# add --burn to also print the ffmpeg subtitles-filter args (construct only; does not re-encode)
```
Output defaults to `app/projects/<project>/export/final.mp4` (override with `--out`). The `.srt` sidecar is also written automatically by the server export path. Verify the final duration matches the alignment total (T-74 measured a −0.10 s delta over 100 shots — no concat drift).

---

## 8. Validate concurrency 4 vs 6 during the pilot (T-74 follow-up)

T-74 found that with the *instant* mock, raising `concurrency` 4→6 gave **zero** throughput gain (drain is tick- and `bufferSize`-bound, not pool-bound). Under **real provider latency** concurrency should matter — so measure it here:

1. Run part of the pilot at the default `concurrency: 4`; note wall-clock for a batch of shots (`status`/cost timestamps).
2. Set `app/config.json` `"concurrency": 6` (the UI Settings page cannot change concurrency), restart `serve`, and run a comparable batch.
3. Compare throughput. Watch for Higgsfield **rate-limiting / 429s** at 6 concurrent (Phase 0 saw ≥6 concurrent accepted, but real sustained load may differ). Record the winner for the production default.

---

## 9. Go / no-go summary

- **Scale:** GO (T-74 — 100/100 placed, EDL complete, memory flat, 0 defects).
- **Correctness of spend:** verify in this pilot via ledger↔balance↔Higgsfield-transactions reconciliation (step 5).
- **Remaining unknowns to close during the pilot:** real per-job latency and real-1080p export wall-clock (T-74 could not measure these), and concurrency 4-vs-6 under real latency (step 8).
- **Safety:** start at ~20 shots (<10% of balance), reconcile, then scale. Never enable auto-approve for a reviewed pilot. Keep `promptBackend: template` unless you deliberately want to spend Anthropic dollars.

Once the 20-shot batch reconciles cleanly, scaling to a full 10-minute video is purely the product owner's budget call.
