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

### Submit Shot Action
* **Route**: `POST /api/project/:name/shots/:shotId/action`
* **Description**: Processes user reviews (swiping right to approve, swiping left to edit/redo, or requesting a timeline re-animation).
* **Request Body**:
  ```json
  {
    "action": "approve" | "edit" | "redo" | "redoAnimation",
    "instructions": "string (optional, for edit)",
    "animationPrompt": "string (optional, for redoAnimation)"
  }
  ```
* **Actions Behavior**:
  1. `approve`: Sets state of shot to `APPROVED`.
     > [!NOTE]
     > **TODO(T-04)**: Replace inline SQL mutation with a call to the project queue instance: `queue.approve(shotId)`.
  2. `edit`: Appends instructions to current image prompt and sets state back to `PROMPTED`.
     > [!IMPORTANT]
     > **TODO(T-04)**: Must delegate to `queue.requestEdit(shotId, instructions)`. This should transition to `IMAGE_QUEUED` with `referenceImagePath` set for an image-to-image generation job, rather than just text-to-image with appended text.
  3. `redo`: Clears current image prompt and resets shot to `PROMPTED`.
     > [!NOTE]
     > **TODO(T-04)**: Delegate to `queue.requestRedo(shotId)` on the project's queue instance.
  4. `redoAnimation`: Triggers a new video generation using the approved start image with a new motion prompt.
     > [!CAUTION]
     > **TODO(T-04)**: Direct call to `db.updateShotState(shotId, 'APPROVED')` throws an illegal transition error when coming from `VIDEO_READY` or `PLACED`. This must be replaced by a delegation to `queue.redoAnimation(shotId, animationPrompt)` which legally transitions the shot to `VIDEO_QUEUED`.
* **Response**:
  * **Success (200 OK)**:
    ```json
    { "success": true }
    ```
  * **Error (500 Internal Server Error)**:
    ```json
    { "error": "Illegal transition PENDING -> APPROVED..." }
    ```

---

## 2. WebSocket Protocol

Clients connect to the WebSocket server to receive live state updates from the database.

* **Connection URL**: `ws://<server-ip>:<port>/?project=<project_name>`
  - The query parameter `project` specifies the active project the client wants to sync.

### Server-to-Client Messages

#### Project State Sync
* **Trigger**: Broadcasted by the server every 2 seconds (`setInterval` loop) for all connected clients.
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
  > [!NOTE]
  > **TODO(T-04)**: The server currently queries SQLite and broadcasts the entire `shots` array every 2 seconds. In the final version, the active `ShotQueue` instances should emit granular state change events (e.g. `IMAGE_READY`, `VIDEO_READY`, `PLACED`) which are broadcasted immediately over WebSocket, removing the 2s database polling overhead.
