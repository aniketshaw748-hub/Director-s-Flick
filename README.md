# Director's Flick

**Director's Flick** is a local AI-video pipeline and review application that automates the process of transforming a script and voiceover into a fully-produced video. It splits scripts into logical cut-points, aligns narration to voiceover audio using word-level alignment, registers character and prop definitions to keep generated styles consistent, generates keyframes and motion video animations via Higgsfield or Fal.ai providers, and compiles everything through a gapless, frame-accurate preview player and FFmpeg-based timeline exporter.

---

## 🚀 Start the app (one command)

```powershell
cd "C:\Coding\Video Automation"
powershell -File scripts\start-directors-flick.ps1
```

The launcher checks Node/FFmpeg, installs missing dependencies, builds the UI if stale, starts the server, and opens your browser at the app (default `http://localhost:4000`). Cold start ≈ 20s; warm start a few seconds.

Variations:

```powershell
powershell -File scripts\start-directors-flick.ps1 -Port 4000     # pick a port
powershell -File scripts\start-directors-flick.ps1 -NoBrowser     # don't open a browser
```

Stop with `Ctrl+C` in the terminal running it.

> **Important:** after pulling code updates, **restart via this same script** — the server only picks up changes on restart. A stale server with a fresh browser tab produces confusing errors (e.g. valid form input being rejected).

First-run flow: add your Higgsfield account from the account chip (top right) → **Setup** page → name the project, paste script, choose your voiceover → **Create & align** → review deck.

---

## 1. Prerequisites

Make sure the following dependencies are installed globally and added to your system `PATH`:

1. **Node.js**: Version `22.x` or higher (includes npm).
2. **Python**: Version `3.12.x` or higher (required for `stable-ts` alignment script).
3. **FFmpeg**: Version `8.1.1` or higher with `h264_nvenc` support (required for high-performance hardware-accelerated video rendering/muxing).
4. **Higgsfield CLI**: Globally installed npm package (required for real generations on Higgsfield).

---

## 2. Setup & Installation

To install dependencies for both the backend (CLI, server, queue runner) and frontend (React review interface):

```bash
# Clone the repository and navigate into it
cd "Video Automation"

# Install backend dependencies
cd app
npm install

# Install frontend dependencies
cd ../ui
npm install

# Install Python audio alignment package
pip install stable-ts
```

---

## 3. Authentication & Multi-Account Switching

* **Single Account Login**: Authenticate the Higgsfield CLI by running the standard login command:
  ```bash
  higgsfield auth login
  ```
* **Multi-Account Profiles**: Different projects can run concurrently under separate credentials without session clobbering. 
  - Register a scoped credentials profile via:
    ```bash
    npm run cli -- accounts --add <account_name>
    ```
  - The CLI saves these sessions under `app/accounts/<account_name>/credentials.json`.
  - The backend loader injects the appropriate `HIGGSFIELD_CREDENTIALS_PATH` env variable pointing to this credentials file to sandbox the subprocess execution.
  - Active accounts can be bound and switched per-project in the UI. For more details on multi-account configuration and response formats, see [api.md](docs/api.md) and the [User Guide](docs/user-guide.md).

---

## 4. Running the Pipeline

### Happy Path: Headless Pipeline CLI (Mock / Zero-Cost Provider)
To run the entire pipeline end-to-end (init, align, queue generation, and export) in one command using the offline, zero-cost **Mock Provider**:

```bash
cd app
npm run cli -- run my_project --script path/to/script.txt --vo path/to/voiceover.wav --provider mock
```

Alternatively, you can run the pipeline stages manually step-by-step:

```bash
# 1. Initialize project database and folders
npm run cli -- init my_project --script path/to/script.txt --vo path/to/voiceover.wav

# 2. Compute cut-points and align sentences to voiceover
npm run cli -- align my_project

# 3. Process the queue with the mock provider (automatically auto-approves)
npm run cli -- run my_project --provider mock

# 4. Compile the EDL timeline and mux VO into final.mp4
npm run cli -- export my_project

# 5. Review ledger cost breakdown
npm run cli -- cost my_project
```

### Run the App (production, one command)

The launcher checks prerequisites, installs dependencies on first run, builds the UI when it is stale, starts the server (which serves the built UI itself — no Vite process needed), and opens your browser:

```powershell
powershell -File scripts\start-directors-flick.ps1
# options: -Port 4100  |  -NoBrowser
```

The whole app then runs at `http://localhost:4000`. If the port is taken, the server prints a friendly message instead of crashing — close the other instance or pass `-Port`.

**Review on your phone:** your phone must be on the same Wi-Fi as this PC. One-time setup: run `app\scripts\allow-lan.ps1` in an elevated PowerShell (adds inbound firewall rules for the app's ports, Private profile only). Then click the **Phone** button in the app's top bar and scan the QR code — it opens the mobile review page bound to the current project.

### Development mode (hot reload)

For UI development, run the backend and the Vite dev server separately:

1. **Start the Express + WebSocket Backend Server** (runs on port `4000` by default):
   ```bash
   cd app
   npm run cli -- serve
   ```
2. **Start the Vite Dev Server for the React UI**:
   ```bash
   cd ui
   npm run dev
   ```
3. **Open the Desktop Web UI**:
   Navigate to `http://localhost:5173` in your browser.
4. **Access the Mobile Review UI over LAN**:
   The Vite dev server is configured with `host: true`. Connect your computer and mobile phone to the same Wi-Fi network and use the in-app **Phone** QR button (or navigate to `http://<your-computer-ip>:5173/mobile?project=<name>`) to review and approve keyframe shots on your phone.

---

## 5. Running Tests

Unit tests are written using `vitest`. The suite is fully hermetic (zero network calls, zero credit spend, and zero real FFmpeg/Python subprocesses).

To run the backend test suite:
```bash
cd app
npm test
```

---

## 6. Project Layout

| Directory/File | Description |
|---|---|
| [`app/`](app/) | Backend application containing CLI commands, server routing, and SQLite migrations. |
| [`app/src/`](app/src/) | Core backend modules (align, queue runner, media processing, provider adapters). |
| [`app/tests/`](app/tests/) | Vitest unit tests, integration tests, and static test fixtures. |
| [`ui/`](ui/) | Frontend React Single Page Application (Vite/TypeScript/CSS reset system). |
| [`design/`](design/) | Static HTML/CSS mockups and design token definitions (`tokens.css`). |
| [`docs/`](docs/) | Product, cost, API reference, and development guides. |
| `app/projects/` *(gitignored)* | Runtime database and media folder for created projects. |
| `app/accounts/` *(gitignored)* | Saved credential JSON files per registered account profile. |

---

## 7. Reference Documentation Links

* **System Design & Contracts**: [app/ARCHITECTURE.md](app/ARCHITECTURE.md)
* **REST & WebSockets API Reference**: [docs/api.md](docs/api.md)
* **User Onboarding & Elements Guide**: [docs/user-guide.md](docs/user-guide.md)
* **Credit Cost & Pricing Model**: [docs/cost-model.md](docs/cost-model.md)
* **Phase-0 Research & Phase-1 Plans**: [research-and-plan.md](research-and-plan.md)
