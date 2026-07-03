# API Reference — Express Backend & WebSocket Server

This document describes the HTTP REST endpoints and WebSocket message shapes as built in `app/src/server.ts` for **Director's Flick**.

---

## 1. Request Body Limits

The backend uses a path-based body parser dispatcher to enforce scoped JSON payload limits:
* **`POST /api/projects`**: Allows payloads up to **500MB** to accommodate large base64-encoded voiceover audio uploads.
* **All other endpoints**: Capped at a strict **2MB** limit to protect against oversized payloads.

---

## 2. REST Endpoints

### List Projects
* **Route**: `GET /api/projects`
* **Description**: Returns all project directories existing in the server's `projects/` folder.
* **Response**: `string[]` (JSON array of project directory names)
  ```json
  [
    "test_project",
    "lightning_animation"
  ]
  ```

### Get Project Details
* **Route**: `GET /api/project/:name`
* **Description**: Fetches metadata, shots, and elements registered for the specified project database.
* **Success Response (200 OK)**:
  ```json
  {
    "project": {
      "id": "proj-uuid",
      "name": "test_project",
      "scriptPath": "C:/Coding/Video Automation/app/projects/test_project/script.txt",
      "voPath": "C:/Coding/Video Automation/app/projects/test_project/voiceover.wav",
      "config": {
        "provider": "higgsfield-cli",
        "models": { "image": "nano_banana_2", "video": "kling3_0" },
        "bufferSize": 5,
        "concurrency": 4,
        "elementsViaPlaceholders": true,
        "aspectRatio": "16:9"
      },
      "createdAt": "2026-07-03T22:47:39Z",
      "updatedAt": "2026-07-03T22:47:39Z"
    },
    "shots": [
      {
        "id": "shot-uuid",
        "projectId": "proj-uuid",
        "lineIndex": 0,
        "subIndex": 0,
        "state": "IN_REVIEW",
        "line": {
          "index": 0,
          "text": "A robot walks down the street.",
          "start": 0,
          "end": 4.0,
          "duration": 4.0,
          "pauseAfter": 1.0,
          "targetDuration": 5.0
        },
        "elementIds": ["elem-uuid"],
        "attempts": 1,
        "imagePath": "C:/Coding/Video Automation/app/projects/test_project/images/shot-uuid.png"
      }
    ],
    "elements": [
      {
        "id": "elem-uuid",
        "name": "Hapie-ai-bot",
        "category": "character",
        "thumbUrl": "http://localhost:4000/api/project/test_project/media/images/elem-thumb.png"
      }
    ]
  }
  ```
* **Error Response (404 Not Found)**:
  ```json
  {
    "error": "project 'non-existent' does not exist"
  }
  ```

### Serve Project Media
* **Route**: `GET /api/project/:name/media/:type/:file`
* **Description**: Serves static generated images or clips.
  - `:type`: Must be `images` or `clips`.
  - `:file`: Filename including extension (e.g. `<shotId>.png` or `<shotId>.mp4`).
* **Response**: Binary file stream. Status 404 if file does not exist.

### Serve Project Voiceover
* **Route**: `GET /api/project/:name/vo`
* **Description**: Serves the master voiceover audio file for the timeline preview player. Supports HTTP Range requests for gapless audio seeking.
* **Response**: Binary audio file stream. Status 404 if project has no voiceover or file does not exist.

### Get EDL Data
* **Route**: `GET /api/project/:name/edl`
* **Description**: Returns the Edit Decision List (EDL) containing placed clip timestamps and trims for preview playback.
* **Response**: `EDLEntry[]`
  ```json
  [
    {
      "id": "edl-uuid-1",
      "shotId": "shot-uuid-1",
      "clipPath": "C:/Coding/Video Automation/app/projects/test_project/clips/shot-uuid-1.mp4",
      "duration": 5.0,
      "inPoint": 0.0,
      "outPoint": 5.0,
      "start": 0.0,
      "end": 5.0
    }
  ]
  ```
* **Error Response (404 Not Found)**:
  ```json
  {
    "error": "project 'non-existent' does not exist"
  }
  ```

### List Accounts
* **Route**: `GET /api/accounts`
* **Description**: Lists names of all accounts that have a `credentials.json` file inside `app/accounts/`.
* **Response**: `[{ "name": string }]`
  ```json
  [
    { "name": "Max" },
    { "name": "backup-fal" }
  ]
  ```

### Get Account Status (Uncached)
* **Route**: `GET /api/accounts/:name/status`
* **Description**: Spawns a status check CLI call (`higgsfield account status --json`) to verify authentication and fetch current balance. Never cached.
* **Success Response (200 OK)**:
  ```json
  {
    "name": "Max",
    "balance": 1127.15,
    "authenticated": true
  }
  ```
* **Error Response (500 Internal Server Error)**:
  ```json
  {
    "error": "CLI invocation failed..."
  }
  ```

### Get Account Balance (Cached)
* **Route**: `GET /api/accounts/:name/balance`
* **Description**: Returns account balance utilizing a **60-second cache** layer to optimize frequent UI polling.
* **Response**: Includes `cached` boolean metadata.
  ```json
  {
    "name": "Max",
    "balance": 1127.15,
    "authenticated": true,
    "cached": true
  }
  ```

### Add Account
* **Route**: `POST /api/accounts`
* **Description**: Creates the account directory structure and starts the interactive `higgsfield auth login` flow. Since this requires interactive device-auth verification in the user's browser, the endpoint responds immediately with `started: true` and spawns the flow in the background.
* **Request Body**:
  ```json
  {
    "name": "new_account_name"
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "started": true,
    "name": "new_account_name"
  }
  ```
* **Error Response (400 Bad Request)**:
  ```json
  {
    "error": "add-account requires a string \"name\" field"
  }
  ```

### Switch Project Account
* **Route**: `POST /api/project/:name/account`
* **Description**: Switches the active Higgsfield account for the specified project. Evicts the project's cached queue entry to force a clean reconstruction with the new account's credentials.
* **Request Body**:
  ```json
  {
    "account": "Max"
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "success": true
  }
  ```
* **Error Response**:
  - `400 Bad Request`: `{ "error": "switch-account requires a string \"account\" field" }`
  - `404 Not Found`: `{ "error": "unknown account 'Max' (no credentials.json)" }`

### Create Project
* **Route**: `POST /api/projects`
* **Description**: Creates a new project workspace. Writes the script text and decodes the base64 voiceover audio into files.
* **Request Body**:
  ```json
  {
    "name": "project_name",
    "script": "Narration text line 1. Line 2.",
    "voiceoverBase64": "SGVsbG8gd29ybGQ=",
    "voiceoverExt": "wav"
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "project": {
      "id": "proj-uuid",
      "name": "project_name",
      "scriptPath": "C:/Coding/Video Automation/app/projects/project_name/script.txt",
      "voPath": "C:/Coding/Video Automation/app/projects/project_name/voiceover.wav",
      "config": { ... },
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
  ```
* **Error Response**:
  - `400 Bad Request`: `{ "error": "name must be a non-empty string of letters/numbers/_/-" }`
  - `500 Internal Server Error`: `{ "error": "Disk write / DB constraint failure" }`

### Align Script
* **Route**: `POST /api/project/:name/align`
* **Description**: Performs audio-to-text alignment via the `stable-ts` Python execution layer. Computes timings, generates initial shot list timings, inserts shot timing rows into the database, and plans shots. Broadcasts live alignment progress events to WS clients.
* **Response**:
  * **Success (200 OK)**:
    ```json
    {
      "success": true,
      "shotCount": 12
    }
    ```
  * **Conflict (409 Conflict)**:
    ```json
    {
      "error": "project already has shots planned"
    }
    ```
  * **Error (500 Internal Server Error)**:
    ```json
    {
      "error": "Alignment execution failed..."
    }
    ```

### Start generation Queue
* **Route**: `POST /api/project/:name/run`
* **Description**: Starts or resumes the background `ShotQueue` review-gate processing loop.
* **Response**: `{ "success": true, "running": true }`

### Stop generation Queue
* **Route**: `POST /api/project/:name/stop`
* **Description**: Stops the background `ShotQueue` processing loop.
* **Response**: `{ "success": true, "running": false }`

### List Element Registry
* **Route**: `GET /api/project/:name/elements`
* **Description**: Fetches all character, location, or prop element definitions registered for this project.
* **Response**: `ElementRef[]`

### Register or Update Element
* **Route**: `POST /api/project/:name/elements`
* **Description**: Upserts a character, location, or prop reference.
* **Request Body**:
  ```json
  {
    "id": "element-uuid",
    "name": "char_name",
    "category": "character" | "location" | "prop",
    "thumbUrl": "http://..." // optional thumbnail URL
  }
  ```
* **Success Response (200 OK)**: `{ "success": true }`
* **Error Response (400 Bad Request)**: `{ "error": "category must be character | location | prop" }`

### Export Timeline
* **Route**: `POST /api/project/:name/export`
* **Description**: Compiles EDL entries and master VO into a final MP4. Tracks progress and broadcasts it as WS events.
* **Safety Guard (T-42)**: If not all shots are placed yet (`placed < total`), the export will fail with `409 Conflict` unless `force: true` is explicitly provided in the request body.
* **Request Body**:
  ```json
  {
    "force": false,
    "outPath": "C:/custom/export/path.mp4" // optional custom output path
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "outputPath": "C:/Coding/Video Automation/app/projects/project_name/export/final.mp4",
    "placed": 12,
    "total": 12
  }
  ```
* **Error Response (409 Conflict)**:
  ```json
  {
    "error": "only 5 of 12 shots are placed - pass force:true to export anyway",
    "placed": 5,
    "total": 12
  }
  ```

### Project Cost Summary (Mixed Units support)
* **Route**: `GET /api/project/:name/cost-summary`
* **Description**: Groups ledger entries for the project by account name and unit (distinguishing between Higgsfield `credits` and Fal `usd`). Groups pre-migration legacy rows as `credits`.
* **Response**:
  ```json
  {
    "totals": {
      "credits": 21.75,
      "usd": 0.70
    },
    "byAccount": [
      {
        "accountName": "Max",
        "unit": "credits",
        "total": 21.75,
        "entryCount": 3
      },
      {
        "accountName": "backup-fal",
        "unit": "usd",
        "total": 0.70,
        "entryCount": 2
      }
    ]
  }
  ```

### Submit Shot Action (Review-Gate Actions)
* **Route**: `POST /api/project/:name/shots/:shotId/action`
* **Description**: Processes user reviews (swiping right to approve, swiping left to edit/redo, or requesting a timeline re-animation). Delegates execution directly to the project's background `ShotQueue` instance.
* **Request Body**:
  ```json
  {
    "action": "approve" | "edit" | "redo" | "redoAnimation",
    "instructions": "string (required only for edit)",
    "prompt": "string (optional; verbatim override prompt for redo or redoAnimation)"
  }
  ```
* **Actions Behavior**:
  1. `approve`: Sets state of shot to `APPROVED`.
  2. `edit`: Transition shot directly to `IMAGE_QUEUED`. Submits a new image-to-image job referencing the rejected image (`referenceImagePath: shot.imagePath`) and appends the user's `instructions` to the prompt.
     - *Validation*: If `instructions` is missing or empty, returns `400 Bad Request`.
  3. `redo`: Transition shot directly to `IMAGE_QUEUED` and submits a fresh text-to-image job.
     - *Prompt override*: Uses `prompt` verbatim if supplied, otherwise triggers the `PromptEngine` to regenerate the image prompt.
  4. `redoAnimation`: Transition shot directly to `VIDEO_QUEUED` and submits a video generation job from the approved start image (`shot.imagePath`).
     - *Prompt override*: Uses `prompt` verbatim if supplied, otherwise triggers the `PromptEngine` to regenerate the motion prompt.
* **Response**: `{ "success": true }`

---

## 3. WebSocket Protocol

Clients connect to the WebSocket server to receive live state updates, alignment logs, and export progress.

* **Connection URL**: `ws://<server-ip>:<port>/?project=<project_name>`
  * *Error Behavior*: Connecting with a non-existent project name closes the connection immediately with close code **`1008` (Policy Violation)** and close reason **`project not found`**.

### Server-to-Client WS Events

#### Full State Sync Broadcast
* **Trigger**: Emitted every 2 seconds (`setInterval` loop) to sync all connected clients.
* **Payload**:
  ```json
  {
    "type": "sync",
    "shots": [
      {
        "id": "shot-uuid-1",
        "projectId": "proj-uuid",
        "lineIndex": 0,
        "subIndex": 0,
        "state": "IN_REVIEW",
        "line": { ... },
        "elementIds": ["elem-uuid-1"],
        "imagePrompt": "...",
        "animationPrompt": "...",
        "imagePath": "...",
        "videoPath": "...",
        "attempts": 1
      }
    ]
  }
  ```

#### Immediate Shot State Transition Push
* **Trigger**: Fired instantly by the `ShotQueue` whenever any shot transitions state.
* **Payload**:
  ```json
  {
    "type": "shotEvent",
    "shotId": "shot-uuid",
    "state": "IMAGE_QUEUED" | "IMAGE_READY" | "IN_REVIEW" | "APPROVED" | "VIDEO_QUEUED" | "VIDEO_READY" | "PLACED" | "FAILED"
  }
  ```

#### Live Alignment Progress Logs
* **Trigger**: Broadcasted line-by-line during `stable-ts` Python execution.
* **Payload**:
  ```json
  {
    "type": "alignProgress",
    "line": "Segment 1/10: walking down (0.0s - 3.4s)"
  }
  ```

#### Live Export Progress Events
* **Trigger**: Broadcasted when compiling timeline assets into `final.mp4`.
* **Payload**:
  - **Trimming stage**:
    ```json
    {
      "type": "exportProgress",
      "stage": "trim",
      "current": 1,
      "total": 12
    }
    ```
  - **Concatenating stage**:
    ```json
    {
      "type": "exportProgress",
      "stage": "concat"
    }
    ```
  - **Muxing stage**:
    ```json
    {
      "type": "exportProgress",
      "stage": "mux"
    }
    ```
  - **Finished stage**:
    ```json
    {
      "type": "exportProgress",
      "stage": "done",
      "outputPath": "C:/Coding/Video Automation/app/projects/test_project/export/final.mp4",
      "durationSeconds": 34.2
    }
    ```
