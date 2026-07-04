/**
 * panels.tsx — SetupPage building blocks (T-28), composed by SetupPage.tsx.
 * Class names come from ui/src/pages/SetupPage.css + shared atoms in index.css.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ElementRef, Shot, ElementCategory } from '../../../app/src/types';
import type { SetupState } from './useSetupProject';
import { ELEMENT_CATEGORIES, estimateRunCost, isValidProjectName } from './api';
import { useProject } from '../project/ProjectContext';

// ------------------------------------------------------- Chunked production

interface ChunkInfo {
  index: number;
  title: string;
  shotCount: number;
  placed: number;
  approvedOrBeyond: number;
  failed: number;
}

/**
 * Chunk list + active chunk for the current project (owner-directed chunked
 * production): the queue only generates the ACTIVE chunk's shots, so the
 * operator works chunk 1 end-to-end (segments → prompts → images → review),
 * then advances.
 */
function useChunks(projectName: string | null, shotCount: number) {
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [activeChunk, setActive] = useState(0);
  const [switching, setSwitching] = useState(false);

  const refresh = React.useCallback(() => {
    if (!projectName) return;
    fetch(`/api/project/${encodeURIComponent(projectName)}/chunks`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { chunks: ChunkInfo[]; activeChunk: number }) => {
        setChunks(data.chunks ?? []);
        setActive(data.activeChunk ?? 0);
      })
      .catch(() => setChunks([]));
  }, [projectName]);

  useEffect(refresh, [refresh, shotCount]);

  const activate = React.useCallback(
    async (index: number) => {
      if (!projectName) return;
      setSwitching(true);
      try {
        await fetch(`/api/project/${encodeURIComponent(projectName)}/config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeChunk: index }),
        });
        refresh();
      } finally {
        setSwitching(false);
      }
    },
    [projectName, refresh],
  );

  return { chunks, activeChunk, activate, switching };
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
}

function basename(p: string | undefined): string {
  return p ? (p.split(/[\\/]/).pop() ?? p) : '';
}

/** Stable decorative waveform heights (seeded walk — no per-render churn). */
function useWaveHeights(count: number): number[] {
  return useMemo(() => {
    let s = 7;
    const rand = () => ((s = (s * 16807) % 2147483647), s / 2147483647);
    let h = 0.5;
    return Array.from({ length: count }, () => {
      h = Math.min(1, Math.max(0.1, h + (rand() - 0.5) * 0.4));
      return Math.round(h * 100);
    });
  }, [count]);
}

// ------------------------------------------------------------ Progress bars

/**
 * Segmentation+alignment percent (owner-directed "progress for everything"):
 * ACCURATE at milestones the server actually reports (per-chunk LLM calls,
 * aligner phases), FAKED with a slow crawl between them — the bar always
 * moves, never lies backwards, and only 'done' reaches 100.
 */
function useAlignPct(aligning: boolean, alignLines: string[], hasShots: boolean): number {
  const [pct, setPct] = useState(0);
  const wasAligning = useRef(false);

  useEffect(() => {
    if (aligning && !wasAligning.current) setPct(2); // fresh run
    wasAligning.current = aligning;
    if (!aligning) {
      setPct(hasShots ? 100 : 0);
      return;
    }
    let target = 4;
    const chunkLines = alignLines.filter((l) => /segmentation: llm — chunk \d+\/\d+/.test(l));
    const m = /chunk (\d+)\/(\d+)/.exec(chunkLines[chunkLines.length - 1] ?? '');
    if (m) target = 5 + (parseInt(m[1]!, 10) / parseInt(m[2]!, 10)) * 50;
    if (alignLines.some((l) => l.includes('stable-ts'))) target = Math.max(target, 62);
    if (alignLines.some((l) => l.toLowerCase().includes('aligning'))) target = Math.max(target, 68);
    if (alignLines.some((l) => l.includes('aligned') && l.includes('words'))) target = Math.max(target, 88);
    setPct((p) => Math.max(p, Math.min(target, 95)));
  }, [aligning, alignLines, hasShots]);

  // the fake part: crawl toward 95 so long phases still feel alive
  useEffect(() => {
    if (!aligning) return;
    const t = setInterval(() => setPct((p) => Math.min(p + 0.35, 95)), 1000);
    return () => clearInterval(t);
  }, [aligning]);

  return pct;
}

function Bar({ label, pct, active, detail }: { label: string; pct: number; active: boolean; detail?: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 76px', gap: 'var(--sp-3)', alignItems: 'center' }}>
      <span style={{ fontSize: 'var(--fs-12)', color: active ? 'var(--text-1)' : 'var(--text-3)' }}>{label}</span>
      <div style={{ height: '6px', borderRadius: '3px', background: 'var(--surface-2)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, Math.max(0, pct))}%`,
            borderRadius: '3px',
            background: pct >= 100 ? 'var(--lime)' : active ? 'var(--lime)' : 'rgba(185,255,59,0.35)',
            transition: 'width 0.6s ease',
            boxShadow: active && pct < 100 ? '0 0 8px rgba(185,255,59,0.5)' : 'none',
          }}
        />
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', color: 'var(--text-3)', textAlign: 'right' }}>
        {detail ?? `${Math.round(pct)}%`}
      </span>
    </div>
  );
}

const IMAGE_DONE_STATES = ['IMAGE_READY', 'IN_REVIEW', 'APPROVED', 'VIDEO_QUEUED', 'VIDEO_READY', 'PLACED'];
const VIDEO_DONE_STATES = ['VIDEO_READY', 'PLACED'];

/** Three-stage production progress for the ACTIVE chunk. */
function ProgressStrip({
  aligning,
  alignPct,
  shots,
  chunkLabel,
}: {
  aligning: boolean;
  alignPct: number;
  shots: Shot[];
  chunkLabel: string | null;
}) {
  const total = shots.length;
  const imagesDone = shots.filter((s) => IMAGE_DONE_STATES.includes(s.state)).length;
  const videosDone = shots.filter((s) => VIDEO_DONE_STATES.includes(s.state)).length;
  const imagesActive = total > 0 && imagesDone < total && shots.some((s) => s.state === 'IMAGE_QUEUED' || s.state === 'PROMPTED');
  const videosActive = total > 0 && videosDone < total && shots.some((s) => s.state === 'VIDEO_QUEUED');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', padding: 'var(--sp-3) var(--sp-5)', borderBottom: '1px solid var(--border-1)' }}>
      {chunkLabel && (
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)' }}>{chunkLabel}</div>
      )}
      <Bar label="Segmentation & alignment" pct={alignPct} active={aligning} />
      <Bar label="Images" pct={total > 0 ? (imagesDone / total) * 100 : 0} active={imagesActive} detail={total > 0 ? `${imagesDone}/${total}` : '—'} />
      <Bar label="Videos" pct={total > 0 ? (videosDone / total) * 100 : 0} active={videosActive} detail={total > 0 ? `${videosDone}/${total}` : '—'} />
    </div>
  );
}

// ---------------------------------------------------------------- DraftBar

/** New-project controls shown in the page head row. */
export function DraftBar({ state }: { state: SetupState }) {
  const { mode, draft, patchDraft, startDraft, cancelDraft, createAndAlign, busy } = state;
  if (mode === 'view') {
    return (
      <button className="btn btn-secondary" style={{ height: '36px', fontSize: 'var(--fs-13)' }} onClick={startDraft}>
        ＋ New project
      </button>
    );
  }
  const nameOk = isValidProjectName(draft.name);
  const ready = nameOk && draft.script.trim() && draft.voFile && !busy;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
      <input
        className="script-box"
        style={{ height: '36px', width: '220px', padding: '0 var(--sp-3)', fontFamily: 'var(--font-mono)' }}
        placeholder="project-name"
        value={draft.name}
        onChange={(e) => patchDraft({ name: e.target.value })}
        aria-invalid={draft.name.length > 0 && !nameOk}
      />
      <button className="btn btn-primary" style={{ height: '36px' }} disabled={!ready} onClick={() => void createAndAlign()}>
        {busy === 'create' ? 'Creating…' : busy === 'align' ? 'Aligning…' : 'Create & align'}
      </button>
      <button className="btn btn-secondary" style={{ height: '36px' }} onClick={cancelDraft} disabled={busy !== null}>
        Cancel
      </button>
    </div>
  );
}

// ------------------------------------------------------------- UploadCards

export function ScriptCard({ state }: { state: SetupState }) {
  const { mode, project, shots, draft, patchDraft, rerunAlign, busy } = state;
  const { projectName } = useProject();
  const fileRef = useRef<HTMLInputElement>(null);
  const isDraft = mode === 'draft';
  // In-app script editing (owner-directed): expandable + editable in view mode.
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scriptText, setScriptText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    // Load the REAL script.txt (not shot texts) when a project is open.
    if (isDraft || !projectName) {
      setScriptText(null);
      setEditing(false);
      setDirty(false);
      return;
    }
    import('./api').then(({ fetchScript }) =>
      fetchScript(projectName)
        .then((r) => setScriptText(r.script))
        .catch(() => setScriptText(null)),
    );
  }, [isDraft, projectName]);

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    patchDraft({ script: await file.text() });
  };

  const save = async (thenRealign: boolean) => {
    if (!projectName || scriptText === null) return;
    setSaveState('saving');
    try {
      const { saveScript } = await import('./api');
      await saveScript(projectName, scriptText);
      setDirty(false);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2500);
      if (thenRealign) {
        setEditing(false);
        await rerunAlign();
      }
    } catch {
      setSaveState('error');
    }
  };

  return (
    <section className="card upload-card">
      <div className="upload-head">
        <span className="overline">Script</span>
        <span className="spacer"></span>
        {isDraft ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => void onPickFile(e.target.files?.[0])}
            />
            <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Load .txt</button>
          </>
        ) : (
          <>
            <span className="file">{basename(project?.scriptPath) || '—'}</span>
            <span className="meta">{shots.length > 0 ? `${shots.length} shots` : 'not aligned yet'}</span>
            {saveState === 'saved' && <span className="meta" style={{ color: 'var(--lime)' }}>Saved ✓</span>}
            {saveState === 'error' && <span className="meta" style={{ color: 'var(--danger)' }}>Save failed</span>}
            {editing ? (
              <>
                <button className="btn btn-ghost" disabled={saveState === 'saving' || !dirty} onClick={() => void save(false)}>
                  {saveState === 'saving' ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={saveState === 'saving' || !!busy}
                  onClick={() => void save(true)}
                  title="Save the script and re-run segmentation + alignment"
                >
                  Save & Re-align
                </button>
                <button className="btn btn-ghost" onClick={() => setEditing(false)}>Done</button>
              </>
            ) : (
              <button className="btn btn-ghost" disabled={scriptText === null} onClick={() => { setEditing(true); setExpanded(true); }}>
                Edit script
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => setExpanded(!expanded)} title={expanded ? 'Collapse' : 'Expand'}>
              {expanded ? '▾ Collapse' : '▸ Expand'}
            </button>
          </>
        )}
      </div>
      <textarea
        className="script-box"
        spellCheck={false}
        style={!isDraft ? { height: expanded ? '60vh' : undefined, transition: 'height 0.2s ease' } : undefined}
        placeholder={isDraft ? 'Paste the narration script here (one line per cut), or load a .txt file.' : ''}
        value={isDraft ? draft.script : editing || scriptText !== null ? (scriptText ?? '') : shots.map((s) => s.line.text).join('\n')}
        readOnly={!isDraft && !editing}
        onChange={(e) => {
          if (isDraft) patchDraft({ script: e.target.value });
          else if (editing) {
            setScriptText(e.target.value);
            setDirty(true);
          }
        }}
      />
    </section>
  );
}

export function VoiceoverCard({ state }: { state: SetupState }) {
  const { mode, project, shots, draft, patchDraft } = state;
  const fileRef = useRef<HTMLInputElement>(null);
  const bars = useWaveHeights(115);
  const isDraft = mode === 'draft';
  const totalDuration = shots.length > 0 ? shots[shots.length - 1].line.start + shots[shots.length - 1].line.targetDuration : 0;

  return (
    <section className="card upload-card">
      <div className="upload-head">
        <span className="overline">Voiceover</span>
        <span className="spacer"></span>
        {isDraft ? (
          <>
            <span className="file">{draft.voFile ? draft.voFile.name : 'no file chosen'}</span>
            {draft.voFile && <span className="meta">{(draft.voFile.size / 1024 / 1024).toFixed(1)} MB</span>}
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a"
              style={{ display: 'none' }}
              onChange={(e) => patchDraft({ voFile: e.target.files?.[0] ?? null })}
            />
            <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Choose file</button>
          </>
        ) : (
          <>
            <span className="file">{basename(project?.voPath) || '—'}</span>
            <span className="meta">{totalDuration > 0 ? formatTime(totalDuration) : ''}</span>
          </>
        )}
      </div>
      <div className="wave-box">
        <div className="wave" aria-hidden="true">
          {bars.map((h, i) => (
            <i key={i} style={{ height: `${h}%` }}></i>
          ))}
        </div>
        <div className="wave-meta">
          <span>00:00</span>
          <span>{totalDuration > 0 ? formatTime(totalDuration / 2) : '—'}</span>
          <span>{totalDuration > 0 ? formatTime(totalDuration) : '—'}</span>
        </div>
      </div>
    </section>
  );
}

// --------------------------------------------------------------- AlignCard

// mirrors the PipelineConfig.maxShotSeconds contract default — flag-only here,
// the server owns the real value (T-88 phrase segmentation)
const MAX_SHOT_SECONDS = 8;

export function AlignCard({ state }: { state: SetupState }) {
  const { aligning, alignLines, rerunAlign, mode, busy } = state;
  const { projectName } = useProject();
  // in draft mode the previous project's rows are irrelevant — show empty
  const shots = mode === 'draft' ? [] : state.shots;
  const totalDuration = shots.length > 0 ? shots[shots.length - 1].line.start + shots[shots.length - 1].line.targetDuration : 0;
  // Force re-align is server-guarded (refused only if PAID generations exist),
  // so the button stays available whenever a project is open.
  const canRerun = mode === 'view' && !busy;
  const { chunks, activeChunk, activate, switching } = useChunks(mode === 'view' ? projectName : null, shots.length);
  // Progress bars (owner-directed): align pct is milestone+crawl; image/video
  // bars are honest per-shot state counts scoped to the active chunk.
  const alignPct = useAlignPct(aligning, alignLines, shots.length > 0);
  const activeChunkShots = chunks.length > 1 ? shots.filter((s) => (s.line.chunkIndex ?? 0) === activeChunk) : shots;
  const activeChunkTitle = chunks.length > 1 ? (chunks.find((c) => c.index === activeChunk)?.title ?? null) : null;
  // T-88 sub-rows: lines that split into phrase sub-shots share a lineIndex
  const subCounts = new Map<number, number>();
  for (const s of shots) subCounts.set(s.lineIndex, (subCounts.get(s.lineIndex) ?? 0) + 1);

  return (
    <section className="card align-card">
      <div className="align-head">
        <h2>Alignment</h2>
        {shots.length > 0 ? (
          <span className="chip chip-lime"><span className="dot" style={{ boxShadow: 'none' }}></span>aligned · stable-ts</span>
        ) : aligning ? (
          <span className="chip">aligning…</span>
        ) : (
          <span className="chip">not aligned</span>
        )}
        {shots.length > 0 && <span className="chip">{shots.length} shots</span>}
        <span className="spacer"></span>
        <button
          className="btn btn-ghost"
          onClick={() => void rerunAlign()}
          disabled={!canRerun}
          title={shots.length > 0 ? 'Re-run segmentation + alignment (refused only if paid generations exist)' : 'Run stable-ts alignment'}
        >
          {aligning ? 'Running…' : shots.length > 0 ? 'Re-align' : 'Run alignment'}
        </button>
      </div>
      {(aligning || shots.length > 0) && (
        <ProgressStrip
          aligning={aligning}
          alignPct={alignPct}
          shots={activeChunkShots}
          chunkLabel={activeChunkTitle ? `Active chunk: ${activeChunkTitle}` : null}
        />
      )}
      {chunks.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', padding: 'var(--sp-3) var(--sp-5)', borderBottom: '1px solid var(--border-1)' }}>
          {chunks.map((c) => {
            const isActive = c.index === activeChunk;
            const done = c.shotCount > 0 && c.placed === c.shotCount;
            return (
              <button
                key={c.index}
                className={`chip ${isActive ? 'chip-lime' : ''}`}
                style={{ cursor: isActive ? 'default' : 'pointer', opacity: switching ? 0.6 : 1 }}
                disabled={isActive || switching}
                onClick={() => void activate(c.index)}
                title={isActive ? 'Active chunk — only these shots generate' : `Switch production to this chunk (${c.shotCount} shots)`}
              >
                {done ? '✓ ' : isActive ? '▶ ' : ''}
                {c.index + 1}. {c.title.replace(/^(section|chunk|part)\s*\d+\s*[-:.]?\s*/i, '') || c.title}
                {' · '}
                {c.placed}/{c.shotCount}
              </button>
            );
          })}
        </div>
      )}
      {aligning && (
        <div style={{ padding: 'var(--sp-3) var(--sp-5)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', color: 'var(--text-3)' }}>
          {alignLines.length > 0 ? alignLines[alignLines.length - 1] : 'starting stable-ts aligner…'}
        </div>
      )}
      <div className={`align-list ${shots.length > 8 ? 'align-fade' : ''}`}>
        {shots.length > 0 ? (
          shots.map((shot: Shot, i: number) => {
            const subs = subCounts.get(shot.lineIndex) ?? 1;
            const isSub = subs > 1;
            const over = shot.line.duration > MAX_SHOT_SECONDS;
            const chunkIdx = shot.line.chunkIndex ?? 0;
            const prevChunkIdx = i > 0 ? (shots[i - 1].line.chunkIndex ?? 0) : -1;
            const chunkHeader =
              chunks.length > 1 && chunkIdx !== prevChunkIdx ? chunks.find((c) => c.index === chunkIdx) : null;
            return (
            <React.Fragment key={shot.id}>
              {chunkHeader && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
                    padding: 'var(--sp-3) var(--sp-5) var(--sp-2)',
                    fontSize: 'var(--fs-12)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: chunkIdx === activeChunk ? 'var(--lime)' : 'var(--text-3)',
                  }}
                >
                  {chunkIdx === activeChunk ? '▶' : ''} {chunkHeader.title}
                  <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                    {chunkIdx === activeChunk ? '· active — generating' : '· waiting'}
                  </span>
                </div>
              )}
              <div
                className={`align-row${isSub ? ' sub' : ''}${isSub && shot.subIndex === 0 ? ' sub-first' : ''}${isSub && shot.subIndex === subs - 1 ? ' sub-last' : ''}`}
                data-line={shot.lineIndex}
                data-sub={shot.subIndex}
              >
                <span className="ln">L{(shot.lineIndex + 1).toString().padStart(2, '0')}{isSub ? `.${shot.subIndex + 1}` : ''}</span>
                <span className="txt">{shot.line.text}</span>
                <span className="time">{formatTime(shot.line.start)} → {formatTime(shot.line.end)}</span>
                <span className={`dur${over ? ' over' : ''}`} title={over ? `Longer than the ${MAX_SHOT_SECONDS}s shot target` : undefined}>{shot.line.duration.toFixed(1)}s</span>
              </div>
              {shot.line.pauseAfter > 0.05 && (
                <div className="pause">
                  <span className="rule"></span>
                  <span className="p">{shot.line.pauseAfter.toFixed(1)}s pause</span>
                  <span className="rule"></span>
                </div>
              )}
            </React.Fragment>
            );
          })
        ) : (
          <div className="align-row">
            <span className="txt" style={{ color: 'var(--text-3)' }}>
              {aligning ? 'Aligning script to voiceover…' : 'No shots yet — create a project or run alignment to see per-line timings.'}
            </span>
          </div>
        )}
      </div>
      <div className="align-foot">
        <span></span>
        <span className="mono">total {formatTime(totalDuration)}</span>
      </div>
    </section>
  );
}

// ----------------------------------------------------------- ElementsPanel

const CATEGORY_THUMB: Record<ElementCategory, string> = {
  character: 'linear-gradient(180deg,#141C26,#0A0E14)',
  location: 'radial-gradient(80% 70% at 50% 42%,rgba(255,180,84,.35),rgba(255,180,84,0) 65%),linear-gradient(180deg,#18222E,#0A0D12)',
  prop: 'linear-gradient(180deg,#1C1826,#0E0A14)',
};

export function ElementsPanel({ state }: { state: SetupState }) {
  const { elements, addElement, busy, mode } = state;
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ElementCategory>('character');

  const submit = async () => {
    if (!id.trim() || !name.trim()) return;
    await addElement({ id: id.trim(), name: name.trim(), category });
    setAdding(false);
    setId('');
    setName('');
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--r-sm)',
    padding: '6px 10px', color: 'var(--text-1)', fontSize: 'var(--fs-13)', width: '100%',
  };

  return (
    <section className="card panel">
      <div className="panel-head">
        <span className="overline">Elements</span>
        <span className="chip">{elements.length}</span>
        <span className="spacer"></span>
        <button
          className="btn btn-ghost"
          style={{ color: 'var(--lime)' }}
          onClick={() => setAdding((a) => !a)}
          disabled={mode === 'draft'}
          title={mode === 'draft' ? 'Create the project first' : 'Register a Higgsfield Element'}
        >
          ＋ New element
        </button>
      </div>

      {elements.map((el: ElementRef) => (
        <div className="el-row" key={el.id}>
          <div className="el-thumb" style={{ background: CATEGORY_THUMB[el.category] ?? CATEGORY_THUMB.character }}>
            {el.thumbUrl ? (
              <img src={el.thumbUrl} alt={el.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <svg viewBox="0 0 44 44" width="44" height="44"><rect x="12" y="14" width="20" height="16" rx="7" fill="#1C2530" stroke="rgba(255,255,255,.18)" /><circle cx="19" cy="22" r="2.4" fill="#C6FF4D" /><circle cx="25" cy="22" r="2.4" fill="#C6FF4D" /></svg>
            )}
          </div>
          <div className="el-info">
            <span className="at-chip">@{el.name}</span>
            <div className="meta"><span className="el-kind">{el.category}</span> · <span className="mono" style={{ fontSize: '10px' }}>{el.id.slice(0, 8)}…</span></div>
          </div>
        </div>
      ))}

      {adding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', padding: 'var(--sp-3)', border: '1px dashed var(--border-2)', borderRadius: 'var(--r-md)' }}>
          <input style={inputStyle} placeholder="Higgsfield element UUID" value={id} onChange={(e) => setId(e.target.value)} />
          <input style={inputStyle} placeholder="Name (used as @mention)" value={name} onChange={(e) => setName(e.target.value)} />
          <select style={inputStyle} value={category} onChange={(e) => setCategory(e.target.value as ElementCategory)}>
            {ELEMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <button className="btn btn-primary" style={{ height: '32px', flex: 1 }} disabled={!id.trim() || !name.trim() || busy === 'element'} onClick={() => void submit()}>
              {busy === 'element' ? 'Saving…' : 'Add element'}
            </button>
            <button className="btn btn-secondary" style={{ height: '32px' }} onClick={() => setAdding(false)}>Cancel</button>
          </div>
          <p className="hint">Element UUIDs come from Higgsfield (promote a generation or create in the web app), then register here for @-mentions and prompt tags.</p>
        </div>
      ) : (
        elements.length === 0 && (
          <button className="el-create" onClick={() => setAdding(true)} disabled={mode === 'draft'}>
            <span className="plus">＋</span>
            <span><b>Register element</b><div className="sub">Paste a Higgsfield element UUID — or promote any approved frame from Review.</div></span>
          </button>
        )
      )}
    </section>
  );
}

// --------------------------------------------------------------- CostPanel

export function CostPanel({ state }: { state: SetupState }) {
  const { shots } = state;
  const est = estimateRunCost(shots);
  return (
    <section className="card panel">
      <div className="panel-head"><span className="overline">Models &amp; cost</span></div>
      <div>
        <div className="cost-row model"><span>Image · Nano Banana 2</span><span className="v">1.5 cr / image</span></div>
        <div className="cost-row model"><span>Video · Kling 3.0 std, sound off</span><span className="v">6.25 cr / 5 s</span></div>
        <div className="cost-div"></div>
        <div className="cost-row"><span>{shots.length} images + ~20% re-rolls</span><span className="v">{est.imageCr.toFixed(1)} cr</span></div>
        <div className="cost-row"><span>{shots.length} clips (clamped 3–15s)</span><span className="v">{est.videoCr.toFixed(1)} cr</span></div>
        <div className="cost-div"></div>
        <div className="cost-total">
          <span className="label">Estimated run</span>
          <span><span className="big">≈ {est.totalCr.toFixed(0)} cr</span> <span className="usd">${est.usd.toFixed(2)}</span></span>
        </div>
      </div>
      <p className="hint">Every job is pre-flighted with <span className="mono">get_cost</span> and written to this account's ledger.</p>
    </section>
  );
}

// -------------------------------------------------------------- StartPanel

export function StartPanel({ state, onStarted }: { state: SetupState; onStarted?: () => void }) {
  const { shots, running, busy, startGeneration, stopGeneration, mode } = state;
  const canStart = mode === 'view' && shots.length > 0 && !running && busy === null;
  const start = async () => {
    const ok = await startGeneration();
    if (ok) onStarted?.();
  };
  return (
    <div className="start">
      {running ? (
        <>
          <button className="btn btn-secondary" style={{ color: 'var(--danger)' }} onClick={() => void stopGeneration()}>
            Stop generation
          </button>
          <span className="cap">Queue running — first cards land in Review shortly.</span>
        </>
      ) : (
        <>
          <button className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>
            {busy === 'run' ? 'Starting…' : 'Start generation'}
          </button>
          <span className="cap">
            {shots.length === 0 ? 'Align the project first — then start the run.' : 'Queues the first images now — review opens in about a minute.'}
          </span>
        </>
      )}
    </div>
  );
}
