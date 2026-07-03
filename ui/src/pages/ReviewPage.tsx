import React, { useState, useEffect } from 'react';
import { useAutocomplete } from '../useAutocomplete';
import { useProject } from '../project/ProjectContext';
import { mediaUrl } from '../paths';

/** States that mean "the queue is still working toward more review cards". */
const UPSTREAM_STATES = ['PENDING', 'PROMPTED', 'IMAGE_QUEUED', 'IMAGE_READY'] as const;

export default function ReviewPage() {
  const { projectName, shots, elements, backendDown, initialized } = useProject();
  const [isEditPanelOpen, setIsEditPanelOpen] = useState(false);
  const [editInstructions, setEditInstructions] = useState('');
  const [redoPrompt, setRedoPrompt] = useState('');
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // T-41 (T-40 CRITICAL 2): the review-gate queue parks shots at IN_REVIEW —
  // IMAGE_READY is a ≤2s transient. Review surfaces filter IN_REVIEW.
  const activeShotIndex = shots.findIndex((s) => s.state === 'IN_REVIEW');
  const activeShot = activeShotIndex !== -1 ? shots[activeShotIndex] : null;
  const inReviewCount = shots.filter((s) => s.state === 'IN_REVIEW').length;
  const upstreamCount = shots.filter((s) => (UPSTREAM_STATES as readonly string[]).includes(s.state)).length;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (activeShot && !isEditPanelOpen) handleAction('approve');
      } else if (e.key === 'ArrowLeft') {
        if (activeShot && !isEditPanelOpen) setIsEditPanelOpen(true);
      } else if (e.key === 'e' || e.key === 'E') {
        if (activeShot && !isEditPanelOpen) {
          e.preventDefault();
          setIsEditPanelOpen(true);
        }
      } else if (e.key === 'Escape') {
        setIsEditPanelOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShot, isEditPanelOpen]);

  // When active shot changes, prefill redo prompt
  useEffect(() => {
    if (activeShot) {
      setRedoPrompt(activeShot.imagePrompt || '');
      setEditInstructions('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShot?.id]);

  // `acting` guards double-submits: a second approve on the same card would
  // hit an illegal state transition server-side (500) once the first lands.
  const handleAction = async (action: string) => {
    if (!activeShot || !projectName || acting) return;
    setActing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/project/${encodeURIComponent(projectName)}/shots/${activeShot.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, instructions: editInstructions, prompt: redoPrompt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setIsEditPanelOpen(false);
    } catch (e) {
      // T-69: action failures must be visible, not console-only
      setActionError(`${action} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActing(false);
    }
  };

  const renderPrompt = (prompt: string) => {
    if (!prompt) return null;
    return prompt.split(/(<<<.*?>>>)/g).map((part, i) => {
      if (part.startsWith('<<<') && part.endsWith('>>>')) {
        const el = elements.find((x) => part.includes(x.id));
        return <span key={i} className="at-chip">@{el?.name ?? 'Element'}</span>;
      }
      return part;
    });
  };

  const editRef = React.useRef<HTMLTextAreaElement>(null);
  const redoRef = React.useRef<HTMLTextAreaElement>(null);

  const { onChange: onEditChange, AutocompletePopover: EditPopover } = useAutocomplete(elements, editInstructions, setEditInstructions, editRef);
  const { onChange: onRedoChange, AutocompletePopover: RedoPopover } = useAutocomplete(elements, redoPrompt, setRedoPrompt, redoRef);

  return (
    <div className="workspace">
      {/* Buffer Indicator — how many cards are ready to review right now */}
      <div className="buffer-indicator" style={{ position: 'absolute', top: 'var(--sp-6)', left: 'var(--sp-8)', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', background: 'var(--surface-1)', border: '1px solid var(--border-1)', padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-full)', fontSize: 'var(--fs-13)', color: 'var(--text-2)' }}>
        Buffer
        <div style={{ display: 'flex', gap: '4px' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: i < Math.min(inReviewCount, 5) ? 'var(--lime)' : 'var(--surface-3)', boxShadow: i < Math.min(inReviewCount, 5) ? '0 0 6px var(--lime-a35)' : 'none' }}></div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--sp-8)', position: 'relative', perspective: '1200px' }}>
        {activeShot ? (
          <div style={{ width: '800px', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
            <div style={{ height: '450px', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
              {activeShot.imagePath ? (
                <img src={mediaUrl(projectName, 'images', activeShot.imagePath)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} alt="Shot frame" />
              ) : (
                <svg viewBox="0 0 44 44" width="88" height="88" opacity="0.8"><rect x="12" y="14" width="20" height="16" rx="7" fill="#1C2530" stroke="rgba(255,255,255,.18)" /><circle cx="19" cy="22" r="2.4" fill="#C6FF4D" /><circle cx="25" cy="22" r="2.4" fill="#C6FF4D" /><path d="M22 14v-4" stroke="rgba(255,255,255,.3)" strokeWidth="1.5" /><circle cx="22" cy="8" r="1.8" fill="#C6FF4D" opacity="0.8" /></svg>
              )}
            </div>
            <div style={{ padding: 'var(--sp-6)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', background: 'var(--surface-1)', borderTop: '1px solid var(--border-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--text-3)', fontSize: 'var(--fs-12)', fontFamily: 'var(--font-mono)' }}>
                <span>L{(activeShot.lineIndex + 1).toString().padStart(2, '0')} / {shots.length}</span>
                <span>{activeShot.attempts > 1 ? `Attempt ${activeShot.attempts}` : ''}</span>
              </div>
              <div style={{ fontSize: 'var(--fs-18)', fontWeight: 500, color: 'var(--text-1)', lineHeight: 1.4 }}>{activeShot.line.text}</div>
              <div style={{ fontSize: 'var(--fs-14)', color: 'var(--text-3)', lineHeight: 1.6 }}>{renderPrompt(activeShot.imagePrompt || '')}</div>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 'var(--fs-16)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            {backendDown ? (
              <span>Backend offline — see the banner above.</span>
            ) : !initialized ? (
              <span>Loading…</span>
            ) : !projectName ? (
              <span>No project selected — pick one from the top-left switcher or create one in Setup.</span>
            ) : upstreamCount > 0 ? (
              <>
                <span>Generating images…</span>
                <span style={{ fontSize: 'var(--fs-13)' }}>{upstreamCount} shot{upstreamCount === 1 ? '' : 's'} in the pipeline — cards appear here as they finish.</span>
              </>
            ) : shots.length > 0 ? (
              <span>All caught up — every shot is reviewed. Check the Timeline.</span>
            ) : (
              <span>No shots yet — create and align a project in Setup, then start generation.</span>
            )}
          </div>
        )}
      </div>

      {/* Action error (T-69: never console-only) */}
      {actionError && (
        <div role="alert" style={{ position: 'absolute', bottom: 'calc(var(--sp-10) + 96px)', left: '50%', transform: 'translateX(-50%)', background: 'var(--danger-a12)', border: '1px solid var(--danger-a35)', color: 'var(--danger)', borderRadius: 'var(--r-md)', padding: 'var(--sp-2) var(--sp-4)', fontSize: 'var(--fs-12)', zIndex: 15, maxWidth: '520px' }}>
          {actionError}
        </div>
      )}

      {/* Controls */}
      <div style={{ position: 'absolute', bottom: 'var(--sp-10)', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 'var(--sp-8)', zIndex: 10 }}>
        <div style={{ position: 'relative' }}>
          <button className="btn-circle btn-reject" title="Reject / Edit" onClick={() => setIsEditPanelOpen(true)} disabled={!activeShot || acting} style={{ width: '64px', height: '64px', borderRadius: 'var(--r-full)', display: 'grid', placeItems: 'center', boxShadow: 'var(--shadow-2)', border: '1px solid var(--danger-a35)', background: 'var(--surface-2)', color: 'var(--danger)' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
          <div style={{ position: 'absolute', bottom: '-20px', left: '50%', transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>← OR E</div>
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn-circle btn-approve" title="Approve" onClick={() => handleAction('approve')} disabled={!activeShot || acting} style={{ width: '72px', height: '72px', borderRadius: 'var(--r-full)', display: 'grid', placeItems: 'center', boxShadow: 'var(--glow-lime)', border: 'none', background: 'var(--lime)', color: 'var(--lime-ink)' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>
          </button>
          <div style={{ position: 'absolute', bottom: '-24px', left: '50%', transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>→ OR ENTER</div>
        </div>
      </div>

      {/* Edit Panel */}
      <div style={{ position: 'absolute', top: 'var(--sp-4)', bottom: 'var(--sp-4)', right: 'var(--sp-4)', width: '360px', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', transform: isEditPanelOpen ? 'translateX(0)' : 'translateX(120%)', opacity: isEditPanelOpen ? 1 : 0, transition: 'transform var(--t-slow) var(--ease-out), opacity var(--t-slow) var(--ease-out)', zIndex: 20 }}>
        <div style={{ padding: 'var(--sp-4)', borderBottom: '1px solid var(--border-1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 600, fontSize: 'var(--fs-16)' }}>
          Reject Image
          <button style={{ color: 'var(--text-3)' }} onClick={() => setIsEditPanelOpen(false)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div style={{ flex: 1, padding: 'var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Edit instructions</span>
            <div style={{ position: 'relative', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--r-md)', padding: 'var(--sp-3)', color: 'var(--text-1)', fontSize: 'var(--fs-14)' }}>
              <textarea ref={editRef} value={editInstructions} onChange={onEditChange} style={{ width: '100%', height: '100px', background: 'transparent', border: 'none', color: 'inherit', resize: 'none' }} placeholder="e.g. make it darker, remove the bird..."></textarea>
              <EditPopover />
            </div>
            <button onClick={() => handleAction('edit')} disabled={!editInstructions} className="btn-primary" style={{ background: 'var(--lime)', color: 'var(--lime-ink)', height: '44px', borderRadius: 'var(--r-md)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: 'none', opacity: editInstructions ? 1 : 0.5 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
              Apply Edit (Image-to-Image)
            </button>
          </div>

          <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 'var(--fs-12)', fontWeight: 600, margin: 'var(--sp-2) 0' }}>OR</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Rewrite prompt</span>
            <div style={{ position: 'relative', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--r-md)', padding: 'var(--sp-3)', color: 'var(--text-1)', fontSize: 'var(--fs-14)' }}>
              <textarea ref={redoRef} value={redoPrompt} onChange={onRedoChange} style={{ width: '100%', height: '100px', background: 'transparent', border: 'none', color: 'inherit', resize: 'none' }} placeholder="Type @ to mention elements"></textarea>
              <RedoPopover />
            </div>
            <button onClick={() => handleAction('redo')} disabled={!redoPrompt} className="btn-secondary" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-1)', height: '44px', borderRadius: 'var(--r-md)', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
              Redo Generation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
