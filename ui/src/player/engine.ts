/**
 * engine.ts — EDL preview playback engine (T-25).
 *
 * Master clock: the voiceover <audio> element. Two <video> elements (A/B)
 * alternate: the active one is visible and slaved to the audio clock, the
 * standby one preloads the next EDL segment (src set, seeked to inPoint,
 * first frame decoded) so the swap at a clip boundary is a pure visibility
 * flip — no load, no seek, no visible gap.
 *
 * Timeline semantics (mirror of app/src/media.ts export):
 *  - segment i covers [timelineStart, timelineStart + duration) on the master
 *    timeline, sourced from clip time [inPoint, inPoint + duration).
 *  - A generated clip may be shorter than its EDL duration (export pads with
 *    tpad = frozen last frame); the preview reproduces that by letting the
 *    video run out and hold its final frame until the boundary.
 *  - t before the first segment shows the first segment's first frame.
 *
 * Sync policy (audio is never touched; only video chases):
 *  - |drift| <= DRIFT_DEADBAND       -> playbackRate 1
 *  - DEADBAND < |drift| <= SNAP      -> playbackRate nudged (invisible)
 *  - |drift| > SNAP                  -> hard currentTime snap (counted)
 * Drift is sampled per presented frame via requestVideoFrameCallback so the
 * numbers reported by getStats() are real presentation-time measurements.
 */

/** One playable segment, derived from an EDLEntry by the caller. */
export interface PlayerSegment {
  /** EDL entry id */
  id: string;
  shotId: string;
  lineIndex: number;
  /** media URL for the clip */
  src: string;
  /** seconds into the source clip where this segment starts */
  inPoint: number;
  /** seconds on the master timeline where this segment starts */
  timelineStart: number;
  /** seconds this segment occupies on the timeline (== outPoint - inPoint) */
  duration: number;
}

export interface BoundaryMeasurement {
  /** segment index entered */
  segIndex: number;
  /** how late the rAF loop noticed the audio crossing the boundary (ms) */
  crossLagMs: number;
  /** flip -> first new frame presented by the incoming video (ms) */
  firstFrameMs: number;
  /** audio-vs-video error at that first presented frame (ms, signed) */
  initialDriftMs: number;
  /** true when the standby was pre-armed (instant flip path) */
  preloaded: boolean;
}

export interface PlayerStatsSummary {
  driftSamples: number;
  /** signed mean of raw per-frame drift (video - expected), ms */
  driftMeanMs: number;
  driftAbsMeanMs: number;
  driftAbsP95Ms: number;
  driftAbsMaxMs: number;
  /**
   * "wrong frame" error: 0 when the presented frame's time span contains the
   * audio position — i.e. the frame on screen is exactly the frame that
   * belongs there. Positive = frames of real desync.
   */
  spanErrorMeanMs: number;
  spanErrorP95Ms: number;
  spanErrorMaxMs: number;
  /** estimated source frame duration (ms), from presented-frame deltas */
  estFrameMs: number;
  boundaries: BoundaryMeasurement[];
  snaps: number;
  rateNudgeTicks: number;
  missedPreloads: number;
}

type EngineEvent = 'time' | 'play' | 'pause' | 'ended' | 'segment' | 'ready' | 'placeholder';
type Listener = (value: number) => void;

const HAVE_METADATA = 1;
/** no correction below this (audio clock jitter zone), seconds */
const DRIFT_DEADBAND = 0.012;
/** above this we hard-snap currentTime instead of rate-nudging, seconds */
const DRIFT_SNAP = 0.08;
/** max playbackRate deviation while nudging */
const RATE_SPAN = 0.09;
/** treat expected positions within this of clip end as the freeze zone, s */
const FREEZE_EPS = 0.06;

export class PreviewEngine {
  private audio: HTMLAudioElement;
  private vids: [HTMLVideoElement, HTMLVideoElement];
  private srcOf: [string, string] = ['', ''];
  private active = 0;

  private segments: PlayerSegment[] = [];
  /** segment index shown (or intended) in the active video; -1 = pre-roll */
  private curIdx = -1;
  private standbyIdx = -1;
  private standbyReady = false;
  private standbyPreparing = false;
  /** generation counter cancelling stale async seek/load handlers */
  private opGen = 0;
  private pendingLoadIdx: number | null = null;
  /** clip srcs whose media failed to load (T-60: skip w/ placeholder) */
  private deadSrcs = new Set<string>();
  private inPlaceholder = false;
  private errHandlers: [(() => void) | null, (() => void) | null] = [null, null];

  private rafId = 0;
  private disposed = false;
  playing = false;

  // --- measurement state ---
  private driftSamples: { rawMs: number; spanErrMs: number }[] = [];
  private boundaries: BoundaryMeasurement[] = [];
  private snaps = 0;
  private rateNudgeTicks = 0;
  private missedPreloads = 0;
  private lastMediaTime = -1;
  private frameDeltas: number[] = [];
  private pendingBoundary: { segIndex: number; crossLagMs: number; flipAt: number; preloaded: boolean } | null = null;

  private listeners: Record<EngineEvent, Set<Listener>> = {
    time: new Set(), play: new Set(), pause: new Set(),
    ended: new Set(), segment: new Set(), ready: new Set(),
    placeholder: new Set(),
  };

  constructor(audio: HTMLAudioElement, videoA: HTMLVideoElement, videoB: HTMLVideoElement) {
    this.audio = audio;
    this.vids = [videoA, videoB];
    for (const v of this.vids) {
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
    }
    this.applyVisibility();

    this.audio.addEventListener('ended', this.onAudioEnded);
    this.audio.addEventListener('loadedmetadata', this.onAudioMeta);

    this.armFrameSampler(this.vids[0]);
    this.armFrameSampler(this.vids[1]);
    this.rafId = requestAnimationFrame(this.tick);
  }

  // ------------------------------------------------------------------ public

  setSegments(segments: PlayerSegment[]): void {
    this.segments = [...segments].sort((a, b) => a.timelineStart - b.timelineStart);
    this.opGen++;
    this.curIdx = -2; // force a reload on next position apply
    this.standbyIdx = -1;
    this.standbyReady = false;
    this.standbyPreparing = false;
    this.pendingLoadIdx = null;
    // a new EDL may have replaced clips at the same URLs (redo overwrites
    // <shotId>.mp4 in place) — give every clip a fresh chance to load
    this.deadSrcs.clear();
    this.exitPlaceholder();
    if (this.segments.length > 0) this.applyPosition(this.audio.currentTime || 0);
  }

  get duration(): number {
    const segEnd = this.segments.length
      ? this.segments[this.segments.length - 1].timelineStart + this.segments[this.segments.length - 1].duration
      : 0;
    const audioDur = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    return Math.max(segEnd, audioDur);
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  async play(): Promise<void> {
    if (this.disposed || this.segments.length === 0) return;
    if (this.duration > 0 && this.audio.currentTime >= this.duration - 0.05) this.seek(0);
    try {
      await this.audio.play();
    } catch {
      return; // autoplay rejection — stay paused
    }
    this.playing = true;
    this.emit('play', 1);
  }

  pause(): void {
    this.audio.pause();
    for (const v of this.vids) v.pause();
    this.playing = false;
    this.emit('pause', 0);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** Seek the master timeline (scrub-safe; stale async seeks are cancelled). */
  seek(t: number): void {
    if (this.disposed) return;
    const clamped = Math.min(Math.max(t, 0), Math.max(this.duration - 0.001, 0));
    this.audio.currentTime = clamped;
    this.applyPosition(clamped);
    this.emit('time', clamped);
  }

  getStats(): PlayerStatsSummary {
    const raw = this.driftSamples.map((s) => Math.abs(s.rawMs)).sort((a, b) => a - b);
    const span = this.driftSamples.map((s) => s.spanErrMs).sort((a, b) => a - b);
    const pick = (arr: number[], q: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : 0);
    const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const signedMean = mean(this.driftSamples.map((s) => s.rawMs));
    return {
      driftSamples: this.driftSamples.length,
      driftMeanMs: round2(signedMean),
      driftAbsMeanMs: round2(mean(raw)),
      driftAbsP95Ms: round2(pick(raw, 0.95)),
      driftAbsMaxMs: round2(raw.length ? raw[raw.length - 1] : 0),
      spanErrorMeanMs: round2(mean(span)),
      spanErrorP95Ms: round2(pick(span, 0.95)),
      spanErrorMaxMs: round2(span.length ? span[span.length - 1] : 0),
      estFrameMs: round2(median(this.frameDeltas)),
      boundaries: [...this.boundaries],
      snaps: this.snaps,
      rateNudgeTicks: this.rateNudgeTicks,
      missedPreloads: this.missedPreloads,
    };
  }

  resetStats(): void {
    this.driftSamples = [];
    this.boundaries = [];
    this.snaps = 0;
    this.rateNudgeTicks = 0;
    this.missedPreloads = 0;
    this.frameDeltas = [];
    this.lastMediaTime = -1;
  }

  on(event: EngineEvent, fn: Listener): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.audio.removeEventListener('ended', this.onAudioEnded);
    this.audio.removeEventListener('loadedmetadata', this.onAudioMeta);
    this.audio.pause();
    for (const v of this.vids) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
  }

  // ----------------------------------------------------------------- private

  private emit(event: EngineEvent, value: number): void {
    for (const fn of this.listeners[event]) fn(value);
  }

  private onAudioEnded = (): void => {
    this.playing = false;
    for (const v of this.vids) v.pause();
    this.emit('ended', this.audio.currentTime);
    this.emit('pause', 0);
  };

  private onAudioMeta = (): void => {
    this.emit('ready', this.duration);
  };

  private activeVid(): HTMLVideoElement {
    return this.vids[this.active];
  }
  private hiddenVid(): HTMLVideoElement {
    return this.vids[1 - this.active];
  }

  private applyVisibility(): void {
    const [a, b] = this.vids;
    const act = this.active === 0 ? a : b;
    const hid = this.active === 0 ? b : a;
    act.style.opacity = '1';
    act.style.zIndex = '2';
    hid.style.opacity = '0';
    hid.style.zIndex = '1';
  }

  /** Index of the segment whose [start, start+duration) contains t; if t sits
   *  in a gap or past the end, the closest previous segment (hold-last-frame);
   *  -1 when t precedes the first segment. */
  private segmentAt(t: number): number {
    const segs = this.segments;
    let lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].timelineStart <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  private mediaTimeFor(seg: PlayerSegment, t: number, clipDur: number): number {
    const raw = seg.inPoint + (t - seg.timelineStart);
    const max = Number.isFinite(clipDur) && clipDur > 0 ? clipDur - 0.01 : raw;
    return Math.min(Math.max(raw, 0), Math.max(max, 0));
  }

  private setSrc(slot: number, src: string): void {
    if (this.srcOf[slot] === src) return;
    this.srcOf[slot] = src;
    const vid = this.vids[slot];
    // one armed error listener per slot: a failed load otherwise never fires
    // loadedmetadata and the segment loader stalls silently (T-60).
    if (this.errHandlers[slot as 0 | 1]) {
      vid.removeEventListener('error', this.errHandlers[slot as 0 | 1]!);
    }
    const onErr = () => this.markDead(src);
    this.errHandlers[slot as 0 | 1] = onErr;
    vid.addEventListener('error', onErr, { once: true });
    vid.src = src;
    vid.load();
  }

  /** A clip failed to load: remember it, unwedge any pending load/prep that
   *  referenced it, and let the tick switch to the placeholder window. */
  private markDead(src: string): void {
    if (this.deadSrcs.has(src)) return;
    this.deadSrcs.add(src);
    this.opGen++; // cancel armed metadata/seeked handlers for this load
    if (this.pendingLoadIdx !== null && this.segments[this.pendingLoadIdx]?.src === src) {
      this.pendingLoadIdx = null;
    }
    if (this.standbyIdx >= 0 && this.segments[this.standbyIdx]?.src === src) {
      this.standbyIdx = -1;
      this.standbyReady = false;
      this.standbyPreparing = false;
    }
  }

  /** Next segment index at/after `from` whose clip is loadable. */
  private nextAlive(from: number): number {
    for (let i = Math.max(from, 0); i < this.segments.length; i++) {
      if (!this.deadSrcs.has(this.segments[i].src)) return i;
    }
    return -1;
  }

  private enterPlaceholder(): void {
    if (this.inPlaceholder) return;
    this.inPlaceholder = true;
    for (const v of this.vids) {
      v.pause();
      v.style.opacity = '0';
    }
    this.emit('placeholder', 1);
  }

  private exitPlaceholder(restoreVisibility = true): void {
    if (!this.inPlaceholder) return;
    this.inPlaceholder = false;
    if (restoreVisibility) this.applyVisibility();
    this.emit('placeholder', 0);
  }

  /** Run fn once video metadata is available (gen-guarded). */
  private withMetadata(vid: HTMLVideoElement, gen: number, fn: () => void): void {
    if (vid.readyState >= HAVE_METADATA) {
      fn();
      return;
    }
    const handler = () => {
      vid.removeEventListener('loadedmetadata', handler);
      if (gen === this.opGen && !this.disposed) fn();
    };
    vid.addEventListener('loadedmetadata', handler);
  }

  private onceSeeked(vid: HTMLVideoElement, gen: number, fn: () => void): void {
    const handler = () => {
      vid.removeEventListener('seeked', handler);
      if (gen === this.opGen && !this.disposed) fn();
    };
    vid.addEventListener('seeked', handler);
  }

  /**
   * Position the player at timeline time t, loading whatever segment covers
   * it. Loads land in the hidden element and flip in on 'seeked', so the old
   * frame holds during scrubs (no black flash). Within-segment scrubs seek
   * the visible element directly.
   */
  private applyPosition(t: number): void {
    if (this.segments.length === 0) return;
    const idx = this.segmentAt(t);
    const showIdx = Math.max(idx, 0);
    const seg = this.segments[showIdx];
    this.opGen++;
    const gen = this.opGen;

    // dead target: placeholder window instead of a load that can't succeed
    if (this.deadSrcs.has(seg.src)) {
      this.pendingLoadIdx = null;
      this.curIdx = idx;
      this.standbyIdx = -1;
      this.standbyReady = false;
      this.standbyPreparing = false;
      this.enterPlaceholder();
      return;
    }

    // stale standby state after any explicit reposition
    this.standbyIdx = -1;
    this.standbyReady = false;
    this.standbyPreparing = false;

    if (idx === this.curIdx && this.srcOf[this.active] === seg.src && this.pendingLoadIdx === null) {
      // scrub within the current clip: seek in place
      const vid = this.activeVid();
      this.withMetadata(vid, gen, () => {
        vid.currentTime = this.mediaTimeFor(seg, Math.max(t, seg.timelineStart), vid.duration);
      });
      return;
    }

    const slot = 1 - this.active;
    const vid = this.vids[slot];
    this.pendingLoadIdx = idx;
    vid.pause();
    this.setSrc(slot, seg.src);
    this.withMetadata(vid, gen, () => {
      vid.currentTime = this.mediaTimeFor(seg, Math.max(t, seg.timelineStart), vid.duration);
      this.onceSeeked(vid, gen, () => {
        this.pendingLoadIdx = null;
        this.curIdx = idx;
        const old = this.activeVid();
        this.active = slot;
        this.exitPlaceholder(false);
        this.applyVisibility();
        old.pause();
        if (this.playing && idx >= 0) void vid.play();
        this.emit('segment', showIdx);
      });
    });
  }

  /** Preload the next segment into the hidden element, seeked + decoded. */
  private prepareStandby(idx: number): void {
    const seg = this.segments[idx];
    if (!seg || this.deadSrcs.has(seg.src) || this.standbyPreparing || this.standbyIdx === idx || this.pendingLoadIdx !== null) return;
    this.standbyIdx = idx;
    this.standbyReady = false;
    this.standbyPreparing = true;
    const gen = this.opGen;
    const slot = 1 - this.active;
    const vid = this.vids[slot];
    vid.pause();
    this.setSrc(slot, seg.src);
    this.withMetadata(vid, gen, () => {
      vid.currentTime = this.mediaTimeFor(seg, seg.timelineStart, vid.duration);
      this.onceSeeked(vid, gen, () => {
        this.standbyPreparing = false;
        this.standbyReady = true;
      });
    });
  }

  /** Instant A/B flip at a natural boundary (standby pre-armed). */
  private swapToStandby(idx: number, t: number): void {
    this.exitPlaceholder(false); // swap sets visibility itself
    const seg = this.segments[idx];
    const vid = this.hiddenVid();
    const crossLagMs = (t - seg.timelineStart) * 1000;
    const flipAt = performance.now();
    vid.playbackRate = 1;
    if (this.playing) void vid.play();
    const old = this.activeVid();
    this.active = 1 - this.active;
    this.applyVisibility();
    old.pause();
    this.curIdx = idx;
    this.standbyIdx = -1;
    this.standbyReady = false;
    this.lastMediaTime = -1;
    this.pendingBoundary = { segIndex: idx, crossLagMs, flipAt, preloaded: true };
    this.emit('segment', idx);
  }

  // The rAF loop: boundary detection, drift correction, standby prep.
  private tick = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.tick);
    if (this.segments.length === 0) return;

    const t = this.audio.currentTime;
    const idx = this.segmentAt(t);
    const seg = idx >= 0 ? this.segments[idx] : null;

    if (seg && this.deadSrcs.has(seg.src)) {
      // T-60 placeholder window: the clip is unloadable — hide video, let the
      // VO master clock run on, keep the NEXT alive segment armed below.
      this.enterPlaceholder();
      this.curIdx = idx;
    } else if (this.pendingLoadIdx === null && idx !== this.curIdx) {
      if (this.standbyIdx === idx && this.standbyReady) {
        // covers both the adjacent boundary and re-entry after a dead window
        this.swapToStandby(idx, t);
      } else {
        if (this.playing && idx === this.nextAlive(this.curIdx + 1)) this.missedPreloads++;
        this.applyPosition(t);
      }
    } else if (this.pendingLoadIdx === null && idx >= 0) {
      this.exitPlaceholder();
      this.syncActive(this.segments[idx], t);
    }

    // keep the next ALIVE segment armed in the hidden element
    if (this.pendingLoadIdx === null) {
      const nextIdx = this.nextAlive(this.curIdx >= 0 ? this.curIdx + 1 : 0);
      if (nextIdx >= 0 && nextIdx !== this.curIdx) this.prepareStandby(nextIdx);
    }

    this.emit('time', t);
  };

  /** Slave the active video to the audio clock. */
  private syncActive(seg: PlayerSegment, t: number): void {
    const vid = this.activeVid();
    if (vid.readyState < 2 || vid.seeking) return;

    const clipDur = vid.duration;
    const expected = seg.inPoint + (t - seg.timelineStart);

    // freeze zone: clip shorter than EDL duration -> hold last frame (tpad)
    if (Number.isFinite(clipDur) && expected >= clipDur - FREEZE_EPS) {
      vid.playbackRate = 1;
      return;
    }

    if (this.playing && vid.paused && !vid.ended) void vid.play();
    if (!this.playing) {
      if (!vid.paused) vid.pause();
      return;
    }

    const drift = vid.currentTime - expected; // + = video ahead of audio
    const abs = Math.abs(drift);
    if (abs > DRIFT_SNAP) {
      vid.currentTime = this.mediaTimeFor(seg, t, clipDur);
      vid.playbackRate = 1;
      this.snaps++;
    } else if (abs > DRIFT_DEADBAND) {
      // video ahead -> slow down; behind -> speed up. Converges in <1s.
      const rate = 1 - Math.sign(drift) * Math.min(abs * 2.5, RATE_SPAN);
      vid.playbackRate = rate;
      this.rateNudgeTicks++;
    } else if (vid.playbackRate !== 1) {
      vid.playbackRate = 1;
    }
  }

  /** Per-presented-frame drift sampling via requestVideoFrameCallback. */
  private armFrameSampler(vid: HTMLVideoElement): void {
    if (typeof vid.requestVideoFrameCallback !== 'function') return; // Chromium-only measurement
    const cb = (now: number, meta: VideoFrameCallbackMetadata): void => {
      if (this.disposed) return;
      vid.requestVideoFrameCallback(cb);
      if (vid !== this.activeVid() || !this.playing || this.curIdx < 0) return;
      const seg = this.segments[this.curIdx];
      if (!seg) return;

      // boundary first-frame latency
      if (this.pendingBoundary && this.pendingBoundary.segIndex === this.curIdx) {
        const b = this.pendingBoundary;
        this.pendingBoundary = null;
        const audioT = this.audio.currentTime;
        const initialDriftMs = (meta.mediaTime - (seg.inPoint + (audioT - seg.timelineStart))) * 1000;
        this.boundaries.push({
          segIndex: b.segIndex,
          crossLagMs: round2(b.crossLagMs),
          firstFrameMs: round2(now - b.flipAt),
          initialDriftMs: round2(initialDriftMs),
          preloaded: b.preloaded,
        });
      }

      // frame-duration estimate from presented-frame deltas
      if (this.lastMediaTime >= 0 && meta.mediaTime > this.lastMediaTime) {
        const d = (meta.mediaTime - this.lastMediaTime) * 1000;
        if (d > 5 && d < 200) this.frameDeltas.push(d);
        if (this.frameDeltas.length > 600) this.frameDeltas.shift();
      }
      this.lastMediaTime = meta.mediaTime;

      const clipDur = vid.duration;
      const audioT = this.audio.currentTime;
      const expected = seg.inPoint + (audioT - seg.timelineStart);
      if (Number.isFinite(clipDur) && expected >= clipDur - FREEZE_EPS) return; // freeze zone: not drift
      const frameMs = median(this.frameDeltas) || 41.7;
      const rawMs = (meta.mediaTime - expected) * 1000;
      // 0 when the audio position falls inside the presented frame's span
      const spanErrMs = rawMs > 0 ? rawMs : Math.max(0, -rawMs - frameMs);
      this.driftSamples.push({ rawMs, spanErrMs });
      if (this.driftSamples.length > 20000) this.driftSamples.shift();
    };
    vid.requestVideoFrameCallback(cb);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
}
