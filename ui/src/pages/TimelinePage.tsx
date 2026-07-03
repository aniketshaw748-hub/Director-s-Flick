import React from 'react';
import type { Shot } from '../../../app/src/types';

export default function TimelinePage({ shots }: { shots: Shot[] }) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
  };

  const totalLines = shots.length > 0 ? shots.length : 96;
  const totalDuration = shots.length > 0 ? shots[shots.length - 1].line.start + shots[shots.length - 1].line.targetDuration : 582;
  const placedShots = shots.filter(s => s.state === 'PLACED').length;
  
  const [isExporting, setIsExporting] = React.useState(false);

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

  return (
    <div className="workspace">
      <div className="preview-area">
        <div className="player-container">
          <div className="player-vid">
             {/* Placeholder for video */}
             <svg viewBox="0 0 44 44" width="88" height="88" opacity="0.3"><rect x="12" y="14" width="20" height="16" rx="7" fill="#1C2530" stroke="rgba(255,255,255,.18)"/><path d="M22 14v-4" stroke="rgba(255,255,255,.3)" strokeWidth="1.5"/></svg>
          </div>
          <div className="player-controls">
            <button className="play-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M4 2.5l8 4.5-8 4.5v-9z"/></svg></button>
            <span className="timecode">00:22.4 / {formatTime(totalDuration)}</span>
          </div>
        </div>

        <div className="export-panel">
          <div>
            <div className="overline">Project Stats</div>
            <div className="stats-row"><span>Shots placed</span><span className="v">{placedShots} / {totalLines}</span></div>
            <div className="stats-row"><span>Total duration</span><span className="v">{formatTime(totalDuration)}</span></div>
            <div className="stats-row"><span>Credits used</span><span className="v">{creditsUsed} cr</span></div>
          </div>
          <div className="progress-container">
            {isExporting ? (
              <>
                <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-12)', color: 'var(--text-2)', marginBottom: '8px'}}>
                   <span>Exporting... ETA 2m</span><span className="mono" style={{color: 'var(--lime)'}}>45%</span>
                </div>
                <div className="progress-bar"><div className="progress-fill"></div></div>
                <button className="btn btn-secondary" style={{width: '100%', color: 'var(--danger)'}} onClick={handleCancelExport}>Cancel export</button>
              </>
            ) : (
              <button className="btn btn-primary" style={{width: '100%'}} onClick={handleExport} disabled={placedShots === 0}>Export timeline</button>
            )}
          </div>
        </div>
      </div>

      <div className="timeline-area">
        <div className="tl-tools">
          {/* TODO(T-04): Unwired redo-animation button will go live with T-04 */}
          <button className="btn btn-secondary" style={{height: '32px', fontSize: 'var(--fs-13)'}}>
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: '6px'}}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
             Redo animation
          </button>
        </div>
        <div className="tl-track" id="track">
          <div className="tl-ruler">
             <div className="tl-tick">00:00</div>
             <div className="tl-tick">00:10</div>
             <div className="tl-tick">00:20</div>
             <div className="tl-tick">00:30</div>
             <div className="tl-tick">00:40</div>
          </div>
          <div className="playhead"></div>
          <div className="tl-clips">
             {shots.length > 0 ? (
               shots.map(shot => {
                 // Pixel width approximation (10px per second)
                 const width = Math.max(30, shot.line.targetDuration * 10);
                 const isActive = shot.state === 'PLACED';
                 return (
                   <div key={shot.id} className="tl-clip" style={{width: `${width}px`, borderColor: isActive ? 'var(--lime-a35)' : undefined}}>
                      <div className="thumb">
                        {shot.videoPath && (
                          <img src={`/api/project/test_project/media/videos/${shot.videoPath.split('/').pop()?.replace('.mp4', '.jpg')}`} style={{width:'100%', height:'100%', objectFit:'cover'}} onError={(e: any) => e.target.style.display='none'} alt={`Shot ${shot.lineIndex + 1}`} />
                        )}
                      </div>
                     <span className="lbl">L{(shot.lineIndex + 1).toString().padStart(2, '0')}</span>
                   </div>
                 );
               })
             ) : (
               // Mock fallback
               <>
                 <div className="tl-clip" style={{width: '58px'}}><div className="thumb"></div><span className="lbl">L01</span></div>
                 <div className="tl-clip" style={{width: '55px'}}><div className="thumb"></div><span className="lbl">L02</span></div>
                 <div className="tl-clip" style={{width: '67px'}}><div className="thumb"></div><span className="lbl">L03</span></div>
                 <div className="tl-clip" style={{width: '47px', borderColor: 'var(--lime-a35)'}}><div className="thumb"></div><span className="lbl">L04</span></div>
                 <div className="tl-clip" style={{width: '42px'}}><div className="thumb"></div><span className="lbl">L05</span></div>
                 <div className="tl-clip" style={{width: '49px'}}><div className="thumb"></div><span className="lbl">L06</span></div>
               </>
             )}
          </div>
          <div className="tl-audio">
             <div className="tl-audio-wave" id="tl-wave">
               {Array.from({ length: 150 }).map((_, i) => (
                 <i key={i} className={i < 108 ? 'played' : ''} style={{ height: `${Math.max(10, Math.sin(i * 0.2) * 45 + Math.random() * 45)}%` }}></i>
               ))}
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
