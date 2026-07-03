import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAutocomplete } from '../useAutocomplete';
import { useProject } from '../project/ProjectContext';
import { mediaUrl } from '../paths';
import { useSwipe } from '../useSwipe';
import OfflineBanner from '../OfflineBanner';
import './MobileReviewPage.css';

export default function MobileReviewPage() {
  const { projectName, shots, elements, backendDown, initialized } = useProject();
  const editRef = React.useRef<HTMLInputElement>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [editInstructions, setEditInstructions] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { onChange: onEditChange, AutocompletePopover: EditPopover } = useAutocomplete(elements, editInstructions, setEditInstructions, editRef);

  const { handlers, offset, isDragging, animatingOut, reset } = useSwipe({
    onSwipeRight: () => handleAction('approve'),
    onSwipeLeft: () => { reset(); setIsSheetOpen(true); },
  });

  // T-41 (T-40 CRITICAL 2): review-gate shots sit at IN_REVIEW, not IMAGE_READY
  const activeShot = shots.find((s) => s.state === 'IN_REVIEW');

  useEffect(() => {
    reset();
  }, [activeShot?.id, reset]);

  // real balance for the header chip (T-41: kill "2,025 cr" demo money)
  useEffect(() => {
    let alive = true;
    fetch('/api/accounts')
      .then((r) => r.json())
      .then(async (list: { name: string }[]) => {
        if (!Array.isArray(list) || list.length === 0) return;
        const b = await fetch(`/api/accounts/${encodeURIComponent(list[0].name)}/balance`).then((r) => r.json());
        if (alive && typeof b?.balance === 'number') setBalance(b.balance);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const handleAction = async (action: string) => {
    if (!activeShot || !projectName || acting) return;
    setActing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/project/${encodeURIComponent(projectName)}/shots/${activeShot.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, instructions: editInstructions }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setIsSheetOpen(false);
      setEditInstructions('');
    } catch (e) {
      setActionError(`${action} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="mobile-review">
      <header className="topbar">
        <Link to="/timeline" style={{ width: '32px', color: 'var(--text-2)', display: 'block' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6" /></svg>
        </Link>
        <div className="top-title">Review · {activeShot ? `L${(activeShot.lineIndex + 1).toString().padStart(2, '0')}` : backendDown ? 'Offline' : 'All caught up'}</div>
        {balance != null && <div className="account-chip"><span className="cr">{balance.toFixed(0)} cr</span></div>}
      </header>
      <OfflineBanner />
      {actionError && (
        <div role="alert" style={{ background: 'var(--danger-a12)', border: '1px solid var(--danger-a35)', color: 'var(--danger)', borderRadius: 'var(--r-md)', padding: 'var(--sp-2) var(--sp-3)', fontSize: 'var(--fs-12)', margin: 'var(--sp-2) var(--sp-3)' }}>
          {actionError}
        </div>
      )}

      <div className="card-stack" style={{ flex: 1 }}>
        <div className="swipe-card card-bg"></div>
        {activeShot ? (
          <div 
            className="swipe-card card-fg" 
            id="front-card"
            {...handlers}
            style={{ 
              transform: animatingOut === 'right' ? 'translateX(120vw) rotate(30deg)' : animatingOut === 'left' ? 'translateX(-120vw) rotate(-30deg)' : isDragging ? `translateX(${offset}px) rotate(${offset * 0.05}deg)` : 'translateX(0) rotate(0)',
              transition: isDragging ? 'none' : 'transform var(--t-slow) var(--ease-out)',
              touchAction: 'none',
              cursor: isDragging ? 'grabbing' : 'grab'
            }}
          >
            <div className="card-image">
              {activeShot.imagePath ? (
                <img src={mediaUrl(projectName, 'images', activeShot.imagePath)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Shot frame" />
              ) : (
                <svg viewBox="0 0 44 44" width="88" height="88"><rect x="12" y="14" width="20" height="16" rx="7" fill="#1C2530" stroke="rgba(255,255,255,.18)" /><circle cx="19" cy="22" r="2.4" fill="#C6FF4D" /><circle cx="25" cy="22" r="2.4" fill="#C6FF4D" /><path d="M22 14v-4" stroke="rgba(255,255,255,.3)" strokeWidth="1.5" /><circle cx="22" cy="8" r="1.8" fill="#C6FF4D" opacity=".8" /></svg>
              )}
            </div>
            <div className="card-content">
              <div className="card-line">{activeShot.line?.text || 'No text'}</div>
              <div className="card-prompt">{activeShot.imagePrompt}</div>
            </div>
          </div>
        ) : (
          <div className="swipe-card card-fg" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p style={{ color: 'var(--text-2)', textAlign: 'center', padding: '0 24px' }}>
              {backendDown
                ? 'Backend offline — start the server on the PC and this page will reconnect.'
                : !initialized
                  ? 'Loading…'
                  : projectName
                    ? 'No shots to review right now.'
                    : 'No project selected — open Setup on the desktop first.'}
            </p>
          </div>
        )}
      </div>

      <div className="actions">
        <button
          className="btn-circle btn-reject"
          disabled={!activeShot || acting}
          onClick={() => setIsSheetOpen(true)}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
        <button
          className="btn-circle btn-approve"
          disabled={!activeShot || acting}
          onClick={() => handleAction('approve')}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>
        </button>
      </div>

      <div className={`sheet-backdrop ${isSheetOpen ? 'active' : ''}`} onClick={() => setIsSheetOpen(false)}></div>
      <div className={`sheet ${isSheetOpen ? 'active' : ''}`}>
        <div className="sheet-handle"></div>
        <div className="sheet-title">Reject image</div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', position: 'relative' }}>
          <input
            ref={editRef}
            type="text"
            value={editInstructions}
            onChange={onEditChange}
            placeholder="Edit instructions (e.g. make it darker)"
            style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-1)', color: 'var(--text-1)', padding: '8px 12px', borderRadius: 'var(--r-sm)' }}
          />
          <EditPopover />
        </div>

        <button className="btn-row" onClick={() => handleAction('edit')} disabled={!editInstructions}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
          Edit with instructions
        </button>
        <button className="btn-row" onClick={() => handleAction('redo')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          Redo (generate fresh prompt)
        </button>
      </div>
    </div>
  );
}
