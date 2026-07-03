export default function MobileReviewPage({}: { shots: any[] }) {
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100vh', background:'var(--bg-0)'}}>
      <header className="topbar">
        <div className="top-title">Review Mobile</div>
      </header>
      <div className="card-stack" style={{flex:1}}>
         <div>Card Stack Goes Here</div>
      </div>
      <div className="actions">
         <button className="btn-circle btn-reject">X</button>
         <button className="btn-circle btn-approve">O</button>
      </div>
    </div>
  );
}
