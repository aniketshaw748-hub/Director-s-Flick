# Director's Flick

Local AI-video pipeline: Script + Voiceover &rarr; Aligned Lines &rarr; Consistent Keyframes &rarr; Animating Clips &rarr; Timeline EDL &rarr; FFmpeg Muxed Export.

---

## 1. Setup & Installation

### Prerequisites
1. **Node.js**: Version 22 or higher.
2. **Python**: Version 3.12 or higher.
3. **FFmpeg**: Version 8.1.1 (or higher) with `h264_nvenc` support, added to your system `PATH`.
4. **Higgsfield CLI**: (Required for real generation) CLI authentication session. Run `higgsfield auth login` to authenticate.

### Local Installation
1. Clone the repository and navigate to the project directory.
2. **Backend Setup**:
   ```bash
   cd app
   npm install
   ```
> **Mobile Review over LAN:** The Vite dev server is configured with `host: true`. To access the mobile review interface from your phone, connect to the same Wi-Fi network and navigate to `http://<your-local-ip>:5173/mobile` in your mobile browser. The UI is PWA-ready and can be installed to your home screen!
3. **Frontend Setup**:
   ```bash
   cd ../ui
   npm install
   ```
4. **Python Alignment Setup**:
   ```bash
   pip install stable-ts
   ```

---

## 2. CLI Commands Quick Reference

Run backend commands using `npm run cli -- <command>` within the `app/` directory:

| Command | Usage | Description |
|---|---|---|
| `init` | `npm run cli -- init <project> --script <path> --vo <path>` | Initializes a new project directory and its SQLite database. |
| `align` | `npm run cli -- align <project>` | Aligns script sentences with voiceover audio using `stable-ts`, computing cut points and splitting long segments into sub-shots. |
| `elements` | `npm run cli -- elements <project> [--add <id:name:category>]` | Lists or registers reusable Higgsfield character/location/prop element references (`category` = `character` \| `location` \| `prop`). |
| `run` | `npm run cli -- run <project> [--auto-approve]` | Starts the state machine to generate still frames and video animations. |
| `status` | `npm run cli -- status <project>` | Displays status of shots by state, active background jobs, and consumed credits. |
| `export` | `npm run cli -- export <project> [--out <path>]` | Compiles the EDL, trims/normalizes all clips in parallel to 1080p30 CFR, and muxes the voiceover. |
| `cost` | `npm run cli -- cost <project>` | Dumps the cost ledger for the project, showing both preflight estimates and actual charges. |
| `serve` | `npm run cli -- serve [--port <port>]` | Starts the Express + WebSocket backend server (port `4000` by default) to power the review UI. |

---

## 3. Architecture 1-Pager

```
               ┌──────────────────────────────────────────────────┐
               │              Director's Flick App                │
               └────────┬───────────────────────────────┬─────────┘
                        │                               │
                        ▼                               ▼
                 [CLI Interface]                 [server Module]
                   cli.ts / npm                Express + WebSocket
                        │                               │
             ┌──────────┴───────────────┬───────────────┴──────────┐
             ▼                          ▼                          ▼
       [align Module]            [queue Module]             [media Module]
    Stable-ts Aligner           Shot State Machine          FFmpeg & NVENC
    Word-level slices          Auto-approve / Review       Trim, Normalize,
    Long line splitting         Buffer size controls      Concat, and VO Mux
             │                          │                          │
             └──────────────────────────┼──────────────────────────┘
                                        ▼
                                 [db Module]
                            SQLite (WAL) pipeline.db
                         Cost Ledger, EDL & Elements
```

### Module Structure
- **server** (`src/server.ts`): Starts the Express REST API and WebSocket subscription server. Manages live `ShotQueue` and `ProjectDb` instances per active project, and broadcasts real-time `shotEvent` pushes alongside 2-second state sync loops.
- **align** (`src/align.ts`, `scripts/align_cli.py`): Spawns the python aligner, computes line/sub-shot timings based on the timeline rules, and plans pending shots in the database.
- **providers** (`src/providers/`): Abstracts the generation provider interface. Includes `MockProvider` (zero-cost offline simulation) and `HiggsfieldCliProvider` (interacts with the real `higgsfield` CLI).
- **prompts** (`src/prompts.ts`): Orchestrates prompt generation. Employs `ClaudePromptEngine` for generating rich visual prompts in batches with element tags, and `TemplatePromptEngine` for offline mock runs.
- **queue** (`src/queue.ts`): Manages the state machine transitions (`PENDING` &rarr; `PROMPTED` &rarr; `IMAGE_QUEUED` &rarr; `IMAGE_READY` &rarr; `IN_REVIEW` &rarr; `APPROVED` &rarr; `VIDEO_QUEUED` &rarr; `VIDEO_READY` &rarr; `PLACED`) and throttles requests according to concurrency and buffer limits.
- **media** (`src/media.ts`): Invokes local `ffmpeg`/`ffprobe` commands via secure, parameterized subprocess spawning. Handles frame holding/padding, clip concatenation, and audio mapping.
- **db** (`src/db.ts`): Executes SQLite queries via sync bindings (`better-sqlite3`). Provides transactional safety for project, job, shot, EDL, ledger, and element states.

### Timeline Rules & Invariants
- Each line $i$ must cover the interval from its start to the start of the next line:
  $$\text{target\_duration}_i = \text{start}_{i+1} - \text{start}_i$$
- For the last line, the duration includes a trailing pad of `0.5s`:
  $$\text{target\_duration}_{\text{last}} = \text{duration}_{\text{last}} + 0.5\text{s}$$
- Generated video clips are clamped to integer seconds between `3` and `15` seconds:
  $$\text{video\_duration}_i = \text{clamp}(\lceil\text{target\_duration}_i\rceil, 3, 15)$$
- During the final export process, video clips are frame-accurately trimmed to their exact fractional `target_duration`.
