# User Guide — Director's Flick Project Flow

This guide describes the end-to-end workflow, execution stages, character consistency features, and multi-account capabilities of the **Director's Flick** local AI-video pipeline.

---

## 1. Project Workflow Stages

The pipeline follows a step-by-step sequential process to transform raw script and voiceover inputs into a finished, frame-accurate movie:

```
 ┌───────────────┐      ┌─────────────────┐      ┌──────────────────┐
 │ 1. Ingest     ├─────▶│ 2. Align & Split├─────▶│ 3. Register Cast │
 └───────────────┘      └─────────────────┘      └──────────────────┘
                                                          │
 ┌───────────────┐      ┌─────────────────┐               │
 │ 6. Export     │◀─────┤ 5. Review/Redo  │◀──────────────┘
 └───────────────┘      └─────────────────┘
```

### Stage 1: Ingestion
Begin by preparing a narration script (`.txt` file where each line represents a sentence/shot) and a corresponding voiceover (`.wav` audio file).
Use `init` to set up the project:
```bash
npm run cli -- init my-project --script /path/to/script.txt --vo /path/to/voiceover.wav
```
This creates the workspace directories under `app/projects/my-project/` and initializes a local SQLite database (`pipeline.db`).

### Stage 2: Forced Alignment & Sub-Shot Splitting
Next, run the aligner to map text segments to timestamps in the audio:
```bash
npm run cli -- align my-project
```
- Spawns the local Python-based `stable-ts` aligner.
- Computes exact word-level timings and pauses.
- Applies the **Timeline Rule**: each clip starts at the current line's spoken onset and extends until the next line begins, eliminating audio-visual gaps.
- Handles long narration: any segment whose target duration exceeds `15 seconds` (the maximum supported video duration) is split into multiple sub-shots at word boundaries.

### Stage 3: Element Registry
Configure visual consistency before generating assets:
```bash
npm run cli -- elements my-project --add "uuid-1234:Hapie-bot:character"
```
Elements represent recurring characters, locations, or props. You register their Higgsfield-side UUIDs and name tags. These tags will automatically be mapped to `<<<uuid>>>` placeholders during prompt generation.

### Stage 4: Execution & Review Loop
Start the main generation queue:
```bash
npm run cli -- run my-project
# Or start the server to use the React Web/Mobile UI:
npm run cli -- serve
```
- In **Headless Mode** (`--auto-approve`), the pipeline automatically batches prompts, sends them to the provider, downloads completed images/videos, and places them onto the timeline.
- In **Review Mode** (default when using the UI), the pipeline keeps a buffer of 5 shots ready at the `IMAGE_READY` state. Users swipe right to approve (which starts the video generation) or swipe left to request edits/redos.

### Stage 5: Final Export
Compile and render the finished movie:
```bash
npm run cli -- export my-project
```
- Gathers all placed EDL clips.
- Trims and normalizes all videos in parallel (converting them to 1080p30 CFR using hardware-accelerated `h264_nvenc`).
- Concatenates the normalized segments.
- Muxes the master voiceover audio track into the final output.

---

## 2. Character & Visual Consistency (Elements-First)

Maintaining character identity and style consistency across dozens of scenes is achieved using **Higgsfield Elements**:

1. **Prompt Placeholders**: When writing prompts, the LLM incorporates element names. The prompt engine rewrites these names into UUID tags like `<<<56c70c04-c0e1-494c-b923-7f68f36a5be4>>>`.
2. **Video Identity Locked**: By default, character-based shots are generated using `kling3_0` in standard mode with `sound off` and element tags reinforced directly in the video prompts. This prevents the character from morphing or losing their distinct wardrobe and facial traits during camera movements.
3. **Style Bible**: A shared visual configuration (`styleBible` config parameter) defining visual styles, lighting setups, and camera angles is appended to every image-generation batch.

---

## 3. Multi-Account Profile Switching

The pipeline supports registering multiple Higgsfield accounts and switching which one a project uses, so different projects (or the same project over time) can run under separate billing identities.

### Registering an account (CLI)
```bash
npm run cli -- accounts --add my-studio
```
This ensures `app/accounts/my-studio/` exists and spawns `higgsfield auth login`, pointing it at that account's own `credentials.json` via the `HIGGSFIELD_CREDENTIALS_PATH` environment variable (the CLI itself writes the file once you complete the interactive device-auth flow in your browser). Nothing is generated and no credits are spent by this step.

List registered accounts, optionally with a live balance/auth check:
```bash
npm run cli -- accounts            # just the registered names
npm run cli -- accounts --status   # + live balance / "not authenticated" per account
```

### Registering / switching an account (server API)
The same operations are available over HTTP for the review UI:
- `GET /api/accounts` — list registered account names.
- `GET /api/accounts/:name/status` — live balance/auth check for one account.
- `POST /api/accounts` (body `{ "name": "my-studio" }`) — kicks off `higgsfield auth login` scoped to that account and returns immediately (`{ "started": true, "name": "my-studio" }`); the auth flow itself still needs to be completed in a browser.
- `POST /api/project/:name/account` (body `{ "account": "my-studio" }`) — makes `my-studio` the active account for that project. This is picked up the next time the project's generation queue (re)builds its provider — safe at any point, since queue state always resumes from the database.

### How this is used under the hood
- **Isolated sessions**: each account's Higgsfield CLI session lives in its own `app/accounts/<name>/credentials.json`, never the CLI's single global session file, so switching accounts (or running two projects under different accounts at once) never clobbers another account's login.
- **Environment injection**: whenever the backend spawns a `higgsfield` CLI call for a project with an active account, it sets `HIGGSFIELD_CREDENTIALS_PATH` to that account's file for the duration of the call.
- **Per-project selection, not global**: which account a project uses is tracked per project name (not a single app-wide "current account"), so concurrent projects can run under different accounts safely.
- **Cost attribution**: every `cost_ledger` row records the `account_name` it was charged against (alongside the usual preflight/charged credit amounts); `npm run cli -- cost <project>` shows it in the `account` column. Rows written before an account was ever selected simply show no account.
- **No real generation is ever triggered by account management itself** — `accounts --add`/`--status` and their HTTP equivalents only ever call `higgsfield auth login` / `higgsfield account status`, never `generate`.
