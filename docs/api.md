# API Reference — Express Backend & WebSocket Server

This document describes the HTTP REST endpoints and WebSocket message shapes as built in `app/src/server.ts` for **Director's Flick**.

---

## 1. REST Endpoints

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
* **Response**: JSON object containing:
  - `project`: Project metadata (ID, config, paths).
  - `shots`: Ordered list of planned shots and their current states.
  - `elements`: Registered character/location/prop refs.
  * **Success (200 OK)**:
    ```json
    {
      "project": { "id": "proj-uuid", "name": "test_project", ... },
      "shots": [ ... ],
      "elements": [ ... ]
    }
    ```
  * **Error (404 Not Found)**:
    ```json
    {
      "error": "project 'non-existent' not found..."
    }
    ```

### Serve Project Media
* **Route**: `GET /api/project/:name/media/:type/:file`
* **Description**: Serves static generated images or clips.
  - `:type`: Must be `images` or `clips`.
  - `:file`: Filename including extension (e.g. `<shotId>.png` or `<shotId>.mp4`).
* **Response**: Binary file stream. Status 404 if file does not exist.

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
  1. `approve`: Invokes `await queue.approve(shotId)`. Sets state of shot to `APPROVED`.
  2. `edit`: Invokes `await queue.requestEdit(shotId, instructions)`. Submits a new image generation job using the rejected image as a reference (image-to-image), setting state to `IMAGE_QUEUED`.
     - *Validation*: If `instructions` is missing or not a string, the endpoint returns a `400 Bad Request` with `{ "error": "edit requires a string \"instructions\" field" }`.
  3. `redo`: Invokes `await queue.requestRedo(shotId, prompt)`. Submits a fresh image generation job directly, transitioning the shot to `IMAGE_QUEUED`.
     - *Verbatim Prompt override*: If `prompt` is provided in the body, it is used verbatim for the fresh image job.
     - *Regeneration fallback*: If `prompt` is omitted, the `PromptEngine` is queried to regenerate a deterministic image prompt.
  4. `redoAnimation`: Invokes `await queue.redoAnimation(shotId, prompt)`. Submits a new video generation job using the approved start image (`shot.imagePath`), transitioning the shot to `VIDEO_QUEUED`.
     - *Verbatim Prompt override*: If `prompt` is provided in the body, it is used verbatim for the animation motion prompt.
     - *Regeneration fallback*: If `prompt` is omitted, the `PromptEngine` is queried to regenerate a motion prompt.
* **Response**:
  * **Success (200 OK)**:
    ```json
    { "success": true }
    ```
  * **Bad Request (400 Bad Request)**:
    ```json
    { "error": "unknown action 'invalid_action'" }
    ```
  * **Error (500 Internal Server Error)**:
    ```json
    { "error": "Error message from queue execution..." }
    ```

---

## 2. WebSocket Protocol

Clients connect to the WebSocket server to receive live state and progress updates.

* **Connection URL**: `ws://<server-ip>:<port>/?project=<project_name>`
  - The query parameter `project` specifies the active project the client wants to sync. Connecting to a project automatically spins up or retrieves the cached `ShotQueue` driving the background loop.

### Server-to-Client Messages

#### Immediate Shot State Transition Push
* **Trigger**: Fired instantly when any shot changes state in the project's `ShotQueue` (e.g. transitioning `IMAGE_READY`, `VIDEO_READY`, or `PLACED`).
* **Payload**:
  ```json
  {
    "type": "shotEvent",
    "shotId": "shot-uuid",
    "state": "IMAGE_QUEUED" | "IMAGE_READY" | "IN_REVIEW" | "APPROVED" | "VIDEO_QUEUED" | "VIDEO_READY" | "PLACED" | "FAILED"
  }
  ```

#### Full State Sync Broadcast
* **Trigger**: Broadcasted by the server every 2 seconds (`setInterval` loop) for all connected clients to keep layouts robust and in-sync.
* **Payload**:
  ```json
  {
    "type": "sync",
    "shots": [
      {
        "id": "shot-uuid",
        "projectId": "proj-uuid",
        "lineIndex": 0,
        "subIndex": 0,
        "state": "IN_REVIEW",
        "line": { ... },
        "elementIds": [],
        ...
      }
    ]
  }
  ```
