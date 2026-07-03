# Director's Flick: End-User Guide

Welcome to **Director's Flick**, a visual-production workstation designed to transform your scripts and voiceover narrations into high-fidelity AI-generated videos. By leveraging automated audio alignment, consistent element styling, and custom generative AI models, Director's Flick lets you direct, edit, review, and export video productions from a single desktop or mobile interface.

This guide walks you through the entire end-to-end journey of creating and producing a project.

---

## 1. Creating a New Project

Every production starts with two primary creative assets:
1. **The Script**: A plain-text document (`.txt`) where each line represents a scene or narration sequence.
2. **The Voiceover (VO)**: An audio narration (`.wav` or `.mp3`) corresponding to the script lines.

### Steps to Initialize:
* **Through the Web Portal**: On the landing dashboard, click **Create Project**. Provide a unique name for your project, select your script file, upload your voiceover audio, and select your initial generation provider (such as the zero-cost offline `mock` provider or `higgsfield-cli`). Click **Start Generation** to initialize the project.
* **Under the Hood**: Director's Flick reads the voiceover, uses automated AI alignment to identify silent pauses, maps cut-points corresponding to your script lines, and populates the project database with a queue of shots matching your narration timing.

---

## 2. Setting Up Your Production Settings

Once your project is created, click the **Settings** gear icon in the navigation bar to configure the production pipeline.

### Settings Panel Parameters:
* **Generative Models**:
  * **Image Model**: Choose the model used to generate initial scene keyframes (e.g., `kling3_0` or standard Kling variants).
  * **Video Model**: Choose the motion video generation engine (e.g., `kling2_5` or Kling Turbo models).
  * **Video Mode**: Select the generation quality profile (e.g., `std` for standard generations or `high` for high-fidelity animations).
* **Stage Providers**:
  * Customize which provider handles each phase of generation (e.g., using `fal` or `replicate` for keyframes and `higgsfield-cli` for video motion).
* **Style Bible**:
  * A central text prompt instructions area. Enter rules, lighting settings, color palettes, or artistic directions (e.g., "styled in 1980s neon cyberpunk, dramatic dark shadows, cinematic lighting") that will be automatically appended to every shot's prompt to keep visual style consistent across the timeline.
* **Linked Account Profile**:
  * Bind the project to a specific authenticated account to track credit balances and invoice generations separately.

---

## 3. The Review Deck: Approving and Editing Shots

The **Review Deck** is your interactive editing suite where you review, refine, and approve the generated keyframe images. It keeps a rolling buffer of shots in the review state, allowing you to quickly process them.

### Verbs and Actions (Keyboard & Gestures):
You can review shots using either full-screen mobile swipe gestures or desktop mouse/keyboard controls:

| Action | Gesture / Key | What it does | Impact on Identity & Costs |
|---|---|---|---|
| **Approve** | Swipe Right / `A` key | Accepts the generated image. Instantly triggers a video generation job using the approved image as the start frame. | Locks in the character/scene keyframe. Incurs a video generation cost. |
| **Edit w/ Instructions** | Swipe Left (Edit) / `E` key | Opens an input sheet where you type feedback (e.g., "make the robot wear a red hat, add rain"). | **Image-to-Image Generation**: The rejected image is passed as a visual reference alongside your feedback. Maintains character layout, camera angle, and identity. Incurs an image generation cost. |
| **Redo (Fresh Prompt)** | Swipe Left (Redo) / `R` key | Regenerates a brand-new image from scratch. If you provide a prompt override, it uses it verbatim; otherwise, the Prompt Engine generates a fresh prompt from the script line and Style Bible. | **Fresh Text-to-Image**: Generates a completely new image from a random seed. Identity and layout will reset. Incurs an image generation cost. |
| **Re-animate Video** | Re-animate button (Timeline) | Submits a new motion video job using the approved starting keyframe. | The starting frame remains the same, but the motion, camera movement, or speed will be regenerated. Incurs a video generation cost. |

---

## 4. Mobile Review Over LAN

Director's Flick is fully responsive and supports remote reviewing, allowing directors to swipe-approve shots from a phone or tablet.

### Setup Steps:
1. **QR Code Connection**: When you start the Express server, the command-line console displays a QR code containing your local area network (LAN) address.
2. **Scan**: Connect your computer and mobile device to the same Wi-Fi network and scan the QR code with your phone. It opens the mobile-optimized Review Deck (deep-linked directly to your project).
3. **Firewall Access**: If the webpage fails to load on your phone, run the Windows PowerShell helper script `allow-lan.ps1` in the repository root (or adjust your Windows Defender Firewall settings) to allow incoming connections on port `4000`.

---

## 5. Multi-Account Profile Switching

If you work with multiple clients or separate accounts, you can register and switch profiles to sandbox credit budgets.

* **Registering Accounts**: New accounts can be registered through the CLI interface, creating a sandbox profile under `app/accounts/<name>`.
* **Binding to Projects**: In the **Settings** screen, select the profile to link to the project.
* **Sandboxed Execution**: The pipeline sandboxes all execution calls to the provider. Each CLI or API call runs strictly under the credentials linked to that profile, avoiding session pollution.

---

## 6. The Cost Panel: Credits vs. USD

At the top of the interface, the cost panel displays real-time ledger details tracking your production expenditure.

* **Higgsfield Credits (`cr`)**: For projects running on Higgsfield or offline Mock providers, costs are tracked in credits (e.g., `2.50 cr` per video).
* **USD Dollar Ledgers (`$`)**: For projects utilizing `fal` or `replicate` API integrations, costs are tracked directly in USD based on duration and model rates (e.g., `$0.35` per 5s video).
* **Itemized Account Summary**: The panel breaks down the totals by account name and unit (never mixing credits and USD together in one sum) to show exactly who spent what.

---

## 7. Timeline Editing and Exporting

The **Timeline Page** displays your sequence of shots mapped directly against the voiceover timing. You can preview individual clips, scrub the timeline playhead, and listen to the voiceover audio track.

### Exporting the Video:
* Once you are happy with the shots, click **Export** to compile the video.
* The exporter reads the Edit Decision List (EDL) database table, trims and normalizes video clips, concatenates them, multiplexes the voiceover, and outputs a high-performance, hardware-accelerated MP4 file.
* **Partial-Timeline Safety Guard**: If you click **Export** when some shots do not have approved or placed clips, the interface prompts a confirmation warning: **"Not all shots have placed clips. Export anyway?"**.
  * Confirming this forces the exporter to compile a partial timeline with blank placeholders for the unapproved gaps.
