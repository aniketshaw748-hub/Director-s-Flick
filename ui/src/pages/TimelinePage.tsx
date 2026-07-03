import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EDLEntry } from '../../../app/src/types';
import PreviewPlayer from '../player/PreviewPlayer';
import type { PreviewEngine } from '../player/engine';
import type { PlayerSegment } from '../player/engine';
import { useProject } from '../project/ProjectContext';
import { mediaBasename, mediaUrl } from '../paths';
import { useAutocomplete } from '../useAutocomplete';
import '../player/timeline.css';

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

interface ExportState {
  running: boolean;
  stage: string;
  pct: number;
  outputPath?: string;
  durationSeconds?: number;
  error?: string;
}

interface CostSummary {
  totalCredits: number;
  byAccount: { accountName: string | null; totalCredits: number; entryCount: number }[];
}

interface AccountBalance {
  name: string;
  balance: number | null;
  authenticated: boolean;
}

export default function TimelinePage() {
  const { projectName, shots, elements, subscribe } = useProject();
  const [edl, setEdl] = useState<EDLEntry[]>([]);
  const [edlVersion, setEdlVersion] = useState(0);
  const [engine, setEngine] = useState<PreviewEngine | null>(null);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ running: false, stage: '', pct: 0 });
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [redoOpen, setRedoOpen] = useState(false);
  const [redoPrompt, setRedoPrompt] = useState('');
  const [redoBusy, setRedoBusy] = useState(false);

  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const redoTextRef = useRef<HTMLTextAreaElement>(null);
  const lastPlayedBars = useRef(0);
  const scrubbing = useRef(false);

  const autocomplete = useAutocomplete(elements, redoPrompt, setRedoPrompt, redoTextRef);
  const placedShots = shots.filter((s) => s.state === 'PLACED').length;

  const refreshCost = useCallback(() => {
    if (!projectName) return;
    fetch(`/api/project/${encodeURIComponent(projectName)}/cost-summary`)
      .then((r) => r.json())
      .then((data) => {
        if (typeof data?.totalCredits === 'number') setCost(data);
      })
      .catch(() => {});
  }, [projectName]);

  // exportProgress + redo swap-in (PLACED) arrive on the app-level project WS
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type === 'exportProgress') {
          const stage = msg.stage as string;
          if (stage === 'trim') {
            const current = Number(msg.current ?? 0);
            const total = Math.max(Number(msg.total ?? 1), 1);
            setExportState({ running: true, stage: `Trimming clip ${current}/${total}`, pct: 5 + (current / total) * 75 });
          } else if (stage === 'concat') {
            setExportState({ running: true, stage: 'Concatenating clips', pct: 85 });
          } else if (stage === 'mux') {
            setExportState({ running: true, stage: 'Muxing voiceover', pct: 93 });
          } else if (stage === 'done') {
            setExportState({
              running: false,
              stage: 'done',
              pct: 100,
              outputPath: typeof msg.outputPath === 'string' ? msg.outputPath : undefined,
              durationSeconds: typeof msg.durationSeconds === 'number' ? msg.durationSeconds : undefined,
            });
          }
        } else if (msg.type === 'shotEvent' && msg.state === 'PLACED') {
          setEdlVersion((v) => v + 1);
          refreshCost();
        }
      }),
    [subscribe, refreshCost],
  );

  // EDL is the playback source of truth; refetch when project/clips change.
  useEffect(() => {
    let alive = true;
    if (!projectName) {
      setEdl([]);
      return;
    }
    fetch(`/api/project/${encodeURIComponent(projectName)}/edl`)
      .then((r) => r.json())
      .then((data) => {
        if (alive && Array.isArray(data)) setEdl(data);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [projectName, placedShots, edlVersion]);

  // reset per-project UI state on project switch
  useEffect(() => {
    setSelectedShotId(null);
    setExportState({ running: false, stage: '', pct: 0 });
    setConfirmPartial(false);
    setCost(null);
    setRedoOpen(false);
  }, [projectName]);

  // real spend + account balances (cached server-side, status-only CLI)
  useEffect(() => {
    refreshCost();
    const interval = setInterval(refreshCost, 20000);
    fetch('/api/accounts')
      .then((r) => r.json())
      .then(async (list: { name: string }[]) => {
        if (!Array.isArray(list)) return;
        const balances = await Promise.all(
          list.map((a) =>
            fetch(`/api/accounts/${encodeURIComponent(a.name)}/balance`)
              .then((r) => r.json())
              .then((b) => ({ name: a.name, balance: b?.balance ?? null, authenticated: !!b?.authenticated }))
              .catch(() => ({ name: a.name, balance: null, authenticated: false })),
          ),
        );
        setAccounts(balances);
      })
      .catch(() => {});
    return () => clearInterval(interval);
  }, [refreshCost]);

  const segments = useMemo<PlayerSegment[]>(
    () =>
      projectName
        ? edl.map((e) => ({
            id: e.id,
            shotId: e.shotId,
            lineIndex: e.lineIndex,
            src: mediaUrl(projectName, 'clips', e.clipPath),
            inPoint: e.inPoint,
            timelineStart: e.timelineStart,
            duration: e.duration,
          }))
        : [],
    [edl, projectName],
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

  const runExport = async () => {
    setConfirmPartial(false);
    setExportState({ running: true, stage: 'Starting export…', pct: 2 });
    try {
      const res = await fetch(`/api/project/${encodeURIComponent(projectName)}/export`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
      setExportState((s) =>
        s.stage === 'done'
          ? s
          : { running: false, stage: 'done', pct: 100, outputPath: body.outputPath, durationSeconds: s.durationSeconds },
      );
    } catch (e) {
      setExportState({ running: false, stage: '', pct: 0, error: e instanceof Error ? e.message : String(e) });
    }
  };

  // T-41 (T-40 HIGH 3): partially-placed timelines need an explicit confirm
  const handleExportClick = () => {
    if (placedShots < shots.length) {
      setConfirmPartial(true);
      return;
    }
    void runExport();
  };

  const submitRedoAnimation = async () => {
    if (!selectedShotId || !projectName) return;
    setRedoBusy(true);
    try {
      const prompt = redoPrompt.trim();
      const res = await fetch(`/api/project/${encodeURIComponent(projectName)}/shots/${selectedShotId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prompt ? { action: 'redoAnimation', prompt } : { action: 'redoAnimation' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
      setRedoOpen(false);
      setRedoPrompt('');
    } catch (e) {
      console.error('redoAnimation failed:', e);
    } finally {
      setRedoBusy(false);
    }
  };

  const selectedEntry = edl.find((e) => e.shotId === selectedShotId);
  const missingCount = shots.length - placedShots;

  return (
    <div className="workspace">
      <div className="preview-area">
        <PreviewPlayer voSrc={projectName ? `/api/project/${encodeURIComponent(projectName)}/vo` : ''} segments={segments} onEngine={setEngine} />

        <div className="export-panel">
          <div>
            <div className="overline">Project Stats</div>
            <div className="stats-row"><span>Shots placed</span><span className="v">{placedShots} / {shots.length}</span></div>
            <div className="stats-row"><span>Total duration</span><span className="v">{formatTime(totalDuration)}</span></div>
            <div className="stats-row"><span>Credits used</span><span className="v">{cost ? `${cost.totalCredits.toFixed(1)} cr` : '—'}</span></div>
            {cost?.byAccount.map((a) => {
              const bal = accounts.find((x) => x.name === a.accountName);
              return (
                <div className="stats-row" key={a.accountName ?? '(none)'} style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)' }}>
                  <span>· {a.accountName ?? 'no account'} ({a.entryCount} jobs)</span>
                  <span className="v" style={{ color: 'var(--text-2)' }}>
                    {a.totalCredits.toFixed(1)} cr{bal?.balance != null ? ` / bal ${bal.balance.toFixed(1)}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="progress-container">
            {exportState.running ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-12)', color: 'var(--text-2)', marginBottom: '8px' }}>
                  <span>{exportState.stage}</span>
                  <span className="mono" style={{ color: 'var(--lime)' }}>{Math.round(exportState.pct)}%</span>
                </div>
                <div className="progress-bar"><div className="progress-fill" style={{ width: `${exportState.pct}%` }}></div></div>
                <p className="hint" style={{ textAlign: 'center' }}>NVENC trim → concat → VO mux (runs locally, no credits)</p>
              </>
            ) : confirmPartial ? (
              <>
                <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', marginBottom: '8px' }} role="alert">
                  {missingCount} of {shots.length} shots are not placed yet — the export will skip those lines.
                </div>
                <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                  <button className="btn btn-secondary" style={{ flex: 1, color: 'var(--warn)' }} onClick={() => void runExport()}>
                    Export partial
                  </button>
                  <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setConfirmPartial(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                {exportState.stage === 'done' && (
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-2)', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }} title={exportState.outputPath}>
                    <span style={{ color: 'var(--lime)' }}>✓ Exported{exportState.durationSeconds ? ` · ${formatTime(exportState.durationSeconds)}` : ''}</span>
                    <span className="mono">{exportState.outputPath ? mediaBasename(exportState.outputPath) : ''}</span>
                  </div>
                )}
                {exportState.error && (
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--danger)', marginBottom: '8px' }} role="alert">
                    Export failed: {exportState.error}
                  </div>
                )}
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleExportClick} disabled={placedShots === 0 || edl.length === 0 || !projectName}>
                  {exportState.stage === 'done' ? 'Export again' : 'Export timeline'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="timeline-area">
        <div className="tl-tools">
          <button
            className="btn btn-secondary"
            style={{ height: '32px', fontSize: 'var(--fs-13)' }}
            onClick={() => setRedoOpen((o) => !o)}
            disabled={!selectedShotId || !selectedEntry}
            title={selectedEntry ? `Regenerate the clip for L${(selectedEntry.lineIndex + 1).toString().padStart(2, '0')} (same start image)` : 'Select a placed clip first'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
            Redo animation
          </button>
          {redoOpen && selectedEntry && (
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flex: 1, maxWidth: '720px' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <textarea
                  ref={redoTextRef}
                  className="script-box"
                  style={{ height: '32px', padding: '5px 10px', resize: 'none', fontSize: 'var(--fs-13)' }}
                  placeholder={`New animation prompt for L${(selectedEntry.lineIndex + 1).toString().padStart(2, '0')} — @ mentions elements; leave empty to regenerate automatically`}
                  value={redoPrompt}
                  onChange={autocomplete.onChange}
                />
                <autocomplete.AutocompletePopover />
              </div>
              <button className="btn btn-primary" style={{ height: '32px', fontSize: 'var(--fs-13)' }} onClick={() => void submitRedoAnimation()} disabled={redoBusy}>
                {redoBusy ? 'Queuing…' : 'Regenerate clip'}
              </button>
              <button className="btn btn-secondary" style={{ height: '32px', fontSize: 'var(--fs-13)' }} onClick={() => setRedoOpen(false)}>✕</button>
            </div>
          )}
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
                        src={mediaUrl(projectName, 'images', mediaBasename(entry.clipPath).replace('.mp4', '.png'))}
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
                {projectName ? 'No placed clips yet — approve shots in Review to build the timeline.' : 'No project selected — pick one from the top-left switcher.'}
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
