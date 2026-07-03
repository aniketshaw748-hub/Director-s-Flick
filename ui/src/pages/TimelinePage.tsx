export default function TimelinePage({}: { shots: any[] }) {
  return (
    <div className="workspace">
      <div className="preview-area">
        <div className="player-container">
           <div className="player-vid">
             <div style={{color:'white'}}>Video Preview</div>
           </div>
        </div>
        <div className="export-panel">
          <div className="overline">Project Stats</div>
          <div>Timeline stats...</div>
        </div>
      </div>
      <div className="timeline-area">
         <div>Timeline track goes here...</div>
      </div>
    </div>
  );
}
