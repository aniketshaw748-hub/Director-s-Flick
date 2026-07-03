import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EDLEntry, Shot } from '../../../app/src/types';
import PreviewPlayer from '../player/PreviewPlayer';
import type { PreviewEngine } from '../player/engine';
import type { PlayerSegment } from '../player/engine';
import '../player/timeline.css';

const PROJECT = 'test_project';
/** timeline strip scale: pixels per second */
const PPS = 12;
/** left padding of the strip content (ruler/clips/wave all share it) */
const PAD = 20;

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
}

function tickLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function clipBasename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Stable waveform bar heights (seeded random walk, same look as the mockup). */
function waveHeights(count: number): number[] {
  let s = 42;
  const rand = () => ((s = (s * 16807) % 2147483647), s / 2147483647);
  let h = 0.45;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = Math.min(1, Math.max(0.1, h + (rand() - 0.5) * 0.5));
    out.push(Math.round(h * 100));
  }
  return out;
}

export default function TimelinePage({ shots }: { shots: Shot[] }) {
  const [edl, setEdl] = useState<EDLEntry[]>([]);
  const [engine, setEngine] = useState<PreviewEngine | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);

  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const lastPlayedBars = useRef(0);
  const scrubbing = useRef(false);

  const placedShots = shots.filter((s) => s.state === 'PLACED').length;

  // EDL is the playback source of truth; refetch when clips land/replace.
  useEffect(() => {
    let alive = true;
    fetch(`/api/project/${PROJECT}/edl`)
      .then((r) => r.json())
      .then((data) => {
        if (alive && Array.isArray(data)) setEdl(data);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [placedShots]);

  const segments = useMemo<PlayerSegment[]>(
    () =>
      edl.map((e) => ({
        id: e.id,
        shotId: e.shotId,
        lineIndex: e.lineIndex,
        src: `/api/project/${PROJECT}/media/clips/${clipBasename(e.clipPath)}`,
        inPoint: e.inPoint,
        timelineStart: e.timelineStart,
        duration: e.duration,
      })),
    [edl],
  );

  const totalDuration = useMemo(() => {
    if (edl.length > 0) {
      const last = edl[edl.length - 1];
      return last.timelineStart + last.duration;
    }
    if (shots.length > 0) {
      const last = shots[shots.length - 1];
      return last.line.start + last.line.targetDuration;
    }
    return 0;
  }, [edl, shots]);

  const contentWidth = PAD + totalDuration * PPS + 60;
  const waveWidth = Math.max(totalDuration * PPS, 0);
  const barHeights = useMemo(() => waveHeights(Math.floor(waveWidth / 3)), [waveWidth]);
  const ticks = useMemo(() => {
    const n = Math.max(1, Math.ceil(totalDuration / 10));
    return Array.from({ length: n }, (_, i) => i * 10);
  }, [totalDuration]);

  useEffect(() => {
    if (!selectedShotId && edl.length > 0) setSelectedShotId(edl[0].shotId);
  }, [edl, selectedShotId]);

  // High-frequency UI (playhead, waveform progress) patched outside React.
  useEffect(() => {
    if (!engine) return;
    return engine.on('time', (t) => {
      if (playheadRef.current) {
        playheadRef.current.style.transform = `translateX(${PAD + t * PPS}px)`;
      }
      const wave = waveRef.current;
      if (wave) {
        const total = engine.duration || 1;
        const bars = wave.children;
        const played = Math.min(bars.length, Math.floor((t / total) * bars.length));
        const prev = lastPlayedBars.current;
        if (played > prev) {
          for (let i = prev; i < played; i++) bars[i].classList.add('played');
        } else if (played < prev) {
          for (let i = prev - 1; i >= played; i--) bars[i].classList.remove('played');
        }
        lastPlayedBars.current = played;
      }
    });
  }, [engine]);

  // Space toggles playback (unless typing in a field).
  useEffect(() => {
    if (!engine) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (e.code !== 'Space' || tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      engine.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  const timeFromPointer = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || !engine) return 0;
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left + track.scrollLeft - PAD;
    return Math.min(Math.max(x / PPS, 0), engine.duration);
  };

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!engine) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    engine.seek(timeFromPointer(e.clientX));
  };
  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current || !engine) return;
    engine.seek(timeFromPointer(e.clientX));
  };
  const onTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // TODO(T-05): Wire actual credits used endpoint when AccountManager is ready
  const creditsUsed = 842.5;

  const handleExport = () => {
    // TODO(T-04): Wire export endpoint
    setIsExporting(true);
  };

  const handleCancelExport = () => {
    // TODO(T-04): Wire cancel export endpoint
    setIsExporting(false);
  };

  const handleRedoAnimation = async () => {
    if (!selectedShotId) return;
    try {
      await fetch(`/api/project/${PROJECT}/shots/${selectedShotId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redoAnimation' }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="workspace">
      <div className="preview-area">
        <PreviewPlayer voSrc={`/api/project/${PROJECT}/vo`} segments={segments} onEngine={setEngine} />

        <div className="export-panel">
          <div>
            <div className="overline">Project Stats</div>
            <div className="stats-row"><span>Shots placed</span><span className="v">{placedShots} / {shots.length}</span></div>
            <div className="stats-row"><span>Total duration</span><span className="v">{formatTime(totalDuration)}</span></div>
            <div className="stats-row"><span>Credits used</span><span className="v">{creditsUsed} cr</span></div>
          </div>
          <div className="progress-container">
            {isExporting ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-12)', color: 'var(--text-2)', marginBottom: '8px' }}>
                  <span>Exporting... ETA 2m</span><span className="mono" style={{ color: 'var(--lime)' }}>45%</span>
                </div>
                <div className="progress-bar"><div className="progress-fill"></div></div>
                <button className="btn btn-secondary" style={{ width: '100%', color: 'var(--danger)' }} onClick={handleCancelExport}>Cancel export</button>
              </>
            ) : (
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleExport} disabled={placedShots === 0}>Export timeline</button>
            )}
          </div>
        </div>
      </div>

      <div className="timeline-area">
        <div className="tl-tools">
          <button className="btn btn-secondary" style={{ height: '32px', fontSize: 'var(--fs-13)' }} onClick={handleRedoAnimation} disabled={!selectedShotId}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
            Redo animation
          </button>
        </div>
        <div
          className="tl-track"
          id="track"
          ref={trackRef}
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
        >
          <div className="tl-ruler" style={{ minWidth: `${contentWidth}px` }}>
            {ticks.map((s) => (
              <div key={s} className="tl-tick" style={{ width: `${10 * PPS}px` }}>{tickLabel(s)}</div>
            ))}
          </div>
          <div className="playhead" ref={playheadRef}></div>
          <div className="tl-clips" style={{ minWidth: `${contentWidth - PAD}px` }}>
            {edl.length > 0 ? (
              edl.map((entry) => {
                const isActive = entry.shotId === selectedShotId;
                return (
                  <div
                    key={entry.id}
                    className="tl-clip"
                    style={{
                      left: `${entry.timelineStart * PPS}px`,
                      width: `${Math.max(entry.duration * PPS - 2, 16)}px`,
                      borderColor: isActive ? 'var(--lime-a35)' : undefined,
                    }}
                    onClick={() => setSelectedShotId(entry.shotId)}
                  >
                    <div className="thumb">
                      <img
                        src={`/api/project/${PROJECT}/media/images/${clipBasename(entry.clipPath).replace('.mp4', '.png')}`}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                        alt={`Shot L${entry.lineIndex + 1}`}
                      />
                    </div>
                    <span className="lbl">L{(entry.lineIndex + 1).toString().padStart(2, '0')}</span>
                  </div>
                );
              })
            ) : (
              <div style={{ color: 'var(--text-3)', fontSize: 'var(--fs-12)', paddingTop: '30px' }}>
                No placed clips yet — approve shots in Review to build the timeline.
              </div>
            )}
          </div>
          <div className="tl-audio">
            <div className="tl-audio-wave" id="tl-wave" ref={waveRef} style={{ width: `${waveWidth}px` }}>
              {barHeights.map((h, i) => (
                <i key={i} style={{ height: `${h}%` }}></i>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
