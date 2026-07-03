import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import './index.css';

// Base Chrome Layout
function Chrome({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  return (
    <div className="app">
      <aside className="rail">
        <div className="logo" title="Pipeline">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3.5 1.8 12 7l-8.5 5.2z" fill="#121600"/></svg>
        </div>
        <Link to="/setup" className={`nav-btn ${loc.pathname === '/setup' ? 'active' : ''}`} title="Setup">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M3 6h9M16 6h1M3 14h3M10 14h7"/><circle cx="13.5" cy="6" r="2"/><circle cx="7.5" cy="14" r="2"/></svg>
        </Link>
        <Link to="/review" className={`nav-btn ${loc.pathname === '/review' ? 'active' : ''}`} title="Review">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}><rect x="5" y="4" width="12" height="13" rx="2.5"/><path d="M3 7v8a2.5 2.5 0 0 0 1.5 2.3" strokeLinecap="round"/></svg>
        </Link>
        <Link to="/timeline" className={`nav-btn ${loc.pathname === '/timeline' ? 'active' : ''}`} title="Timeline">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M3 5.5h14"/><rect x="3" y="9" width="8" height="3.5" rx="1.4"/><rect x="12.5" y="9" width="4.5" height="3.5" rx="1.4"/><path d="M3 16.5h14"/></svg>
        </Link>
        <div className="rail-spacer"></div>
        <div className="avatar">S</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="proj">
            <span className="proj-name">Director's Flick</span>
            <span className="proj-meta">draft · 96 lines · 9:42 voiceover</span>
          </div>
          <div className="top-spacer"></div>
          <button className="account-chip">
            <span className="initial">N</span>
            <span className="name">NexGen Studio</span>
            <span className="cr">2,025.0 cr</span>
          </button>
          <div className="conn"><span className="dot"></span>LAN · live</div>
        </header>
        {children}
      </div>
    </div>
  );
}

// Stubs for the actual pages
import SetupPage from './pages/SetupPage';
import TimelinePage from './pages/TimelinePage';
import MobileReviewPage from './pages/MobileReviewPage';

function App() {
  const [shots, setShots] = useState<any[]>([]);
  
  useEffect(() => {
    // Basic WebSocket connection
    const ws = new WebSocket('ws://localhost:4000/?project=test_project');
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'sync') {
          setShots(data.shots);
        } else if (data.type === 'shot_updated') {
           setShots(prev => prev.map(s => s.id === data.shot.id ? data.shot : s));
        }
      } catch (e) {
        console.error(e);
      }
    };
    return () => ws.close();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<Chrome><SetupPage shots={shots} /></Chrome>} />
        <Route path="/timeline" element={<Chrome><TimelinePage shots={shots} /></Chrome>} />
        <Route path="/review" element={<MobileReviewPage shots={shots} />} />
        <Route path="*" element={<Chrome><SetupPage shots={shots} /></Chrome>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
