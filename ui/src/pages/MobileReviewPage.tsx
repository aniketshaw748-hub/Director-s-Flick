import { useState } from 'react';
import { Link } from 'react-router-dom';

export default function MobileReviewPage({ shots }: { shots: any[] }) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [editInstructions, setEditInstructions] = useState('');

  // Find the first shot ready for review
  const activeShot = shots.find(s => s.state === 'IMAGE_READY');
  const totalReview = shots.filter(s => s.state === 'IMAGE_READY').length;

  const handleAction = async (action: string) => {
    if (!activeShot) return;
    try {
      await fetch(`http://localhost:4000/api/project/test_project/shots/${activeShot.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, instructions: editInstructions })
      });
      setIsSheetOpen(false);
      setEditInstructions('');
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100vh', background:'var(--bg-0)'}}>
      <header className="topbar">
        <Link to="/timeline" style={{width:'32px', color:'var(--text-2)', display:'block'}}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
        </Link>
        <div className="top-title">Review · {activeShot ? `L${activeShot.lineIndex.toString().padStart(2, '0')}` : 'All caught up'}</div>
        <div className="account-chip"><span className="cr">2,025 cr</span></div>
      </header>
      
      <div className="card-stack" style={{flex:1}}>
        <div className="swipe-card card-bg"></div>
        {activeShot ? (
          <div className="swipe-card card-fg" id="front-card">
            <div className="card-image">
              {activeShot.imagePath ? (
                <img src={`http://localhost:4000/api/project/test_project/media/images/${activeShot.imagePath.split('/').pop()}`} style={{width:'100%', height:'100%', objectFit:'cover'}} />
              ) : (
                <svg viewBox="0 0 44 44" width="88" height="88"><rect x="12" y="14" width="20" height="16" rx="7" fill="#1C2530" stroke="rgba(255,255,255,.18)"/><circle cx="19" cy="22" r="2.4" fill="#C6FF4D"/><circle cx="25" cy="22" r="2.4" fill="#C6FF4D"/><path d="M22 14v-4" stroke="rgba(255,255,255,.3)" strokeWidth="1.5"/><circle cx="22" cy="8" r="1.8" fill="#C6FF4D" opacity=".8"/></svg>
              )}
            </div>
            <div className="card-content">
              <div className="card-line">{activeShot.line?.text || 'No text'}</div>
              <div className="card-prompt">{activeShot.imagePrompt}</div>
            </div>
          </div>
        ) : (
          <div className="swipe-card card-fg" style={{display:'flex', alignItems:'center', justifyContent:'center'}}>
             <p style={{color:'var(--text-2)'}}>No shots to review right now.</p>
          </div>
        )}
      </div>

      <div className="actions">
        <button 
          className="btn-circle btn-reject" 
          disabled={!activeShot}
          onClick={() => setIsSheetOpen(true)}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <button 
          className="btn-circle btn-approve" 
          disabled={!activeShot}
          onClick={() => handleAction('approve')}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
        </button>
      </div>

      <div className={`sheet-backdrop ${isSheetOpen ? 'active' : ''}`} onClick={() => setIsSheetOpen(false)}></div>
      <div className={`sheet ${isSheetOpen ? 'active' : ''}`}>
        <div className="sheet-handle"></div>
        <div className="sheet-title">Reject image</div>
        
        <div style={{display:'flex', gap:'8px', marginBottom:'16px'}}>
          <input 
            type="text" 
            value={editInstructions}
            onChange={e => setEditInstructions(e.target.value)}
            placeholder="Edit instructions (e.g. make it darker)" 
            style={{flex:1, background:'var(--surface-2)', border:'1px solid var(--border-1)', color:'white', padding:'8px 12px', borderRadius:'8px'}}
          />
        </div>

        <button className="btn-row" onClick={() => handleAction('edit')} disabled={!editInstructions}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Edit with instructions
        </button>
        <button className="btn-row" onClick={() => handleAction('redo')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          Redo (generate fresh prompt)
        </button>
      </div>
    </div>
  );
}
