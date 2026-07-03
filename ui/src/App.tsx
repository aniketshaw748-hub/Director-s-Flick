import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import './index.css';

// Base Chrome Layout
function Chrome({ children, wsConnected }: { children: React.ReactNode, wsConnected: boolean }) {
  const loc = useLocation();
  const [isAcctDropdownOpen, setIsAcctDropdownOpen] = useState(false);

  return (
    <div className="app">
      <aside className="rail">
        <div className="logo" title="Pipeline">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3.5 1.8 12 7l-8.5 5.2z" fill="#121600"/></svg>
        </div>
        <Link to="/setup" className={`nav-btn ${loc.pathname === '/setup' ? 'active' : ''}`} title="Setup">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M3 6h9M16 6h1M3 14h3M10 14h7"/><circle cx="13.5" cy="6" r="2"/><circle cx="7.5" cy="14" r="2"/></svg>
        </Link>
        <Link to="/deck" className={`nav-btn ${loc.pathname === '/deck' ? 'active' : ''}`} title="Review">
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
          
          <div style={{ position: 'relative' }}>
            {/* TODO(T-05): Wire account balances, names, and auth states */}
            <button className={`account-chip ${isAcctDropdownOpen ? 'active' : ''}`} onClick={() => setIsAcctDropdownOpen(!isAcctDropdownOpen)}>
              <span className="initial">N</span>
              <span className="name">NexGen Studio</span>
              <span className="cr">2,025.0 cr</span>
              <svg className="caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 3.5 5 6.5 8 3.5"/></svg>
            </button>
            
            {isAcctDropdownOpen && (
              <div style={{ position: 'absolute', top: '50px', right: '0', width: '280px', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', padding: 'var(--sp-2)', zIndex: 100 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', cursor: 'pointer' }}>
                  <div style={{ width: '32px', height: '32px', borderRadius: 'var(--r-full)', background: 'var(--lime-a12)', border: '1px solid var(--lime-a20)', color: 'var(--lime)', display: 'grid', placeItems: 'center', fontWeight: 600 }}>N</div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 'var(--fs-14)', fontWeight: 500, color: 'var(--text-1)' }}>NexGen Studio</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', color: 'var(--lime)' }}>2,025.0 cr</span>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--lime)" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', cursor: 'pointer' }} onMouseEnter={e => e.currentTarget.style.background='var(--surface-2)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                  <div style={{ width: '32px', height: '32px', borderRadius: 'var(--r-full)', background: 'var(--surface-3)', border: '1px solid var(--border-2)', color: 'var(--text-1)', display: 'grid', placeItems: 'center', fontWeight: 600 }}>P</div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 'var(--fs-14)', fontWeight: 500, color: 'var(--text-1)' }}>Personal Pro</span>
                    <span style={{ fontSize: 'var(--fs-12)', color: 'var(--danger)' }}>Session expired</span>
                  </div>
                </div>
                <div style={{ height: '1px', background: 'var(--border-1)', margin: 'var(--sp-2) 0' }}></div>
                <button style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', color: 'var(--text-2)', fontWeight: 500, width: '100%' }} onMouseEnter={e => {e.currentTarget.style.background='var(--surface-2)'; e.currentTarget.style.color='var(--text-1)';}} onMouseLeave={e => {e.currentTarget.style.background='transparent'; e.currentTarget.style.color='var(--text-2)';}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14m-7-7h14"/></svg>
                  Add account
                </button>
              </div>
            )}
          </div>

          <div className="conn">
            {wsConnected ? (
              <><span className="dot"></span>LAN · live</>
            ) : (
              <><span className="dot" style={{ background: 'var(--danger)', boxShadow: '0 0 8px var(--danger-a35)' }}></span>Disconnected</>
            )}
          </div>
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
import ReviewPage from './pages/ReviewPage';
import type { Shot, ElementRef } from '../../app/src/types';

function App() {
  const [shots, setShots] = useState<Shot[]>([]);
  const [elements, setElements] = useState<ElementRef[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  
  useEffect(() => {
    fetch('/api/project/test_project')
      .then(res => res.json())
      .then(data => {
        if (data.elements) setElements(data.elements);
      })
      .catch(console.error);

    // Basic WebSocket connection
    const ws = new WebSocket(`ws://${window.location.host}/ws/?project=test_project`);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'sync') {
          setShots(data.shots);
        } else if (data.type === 'shotEvent') {
           setShots(prev => prev.map(s => s.id === data.shotId ? { ...s, state: data.state } : s));
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
        <Route path="/setup" element={<Chrome wsConnected={wsConnected}><SetupPage shots={shots} /></Chrome>} />
        <Route path="/timeline" element={<Chrome wsConnected={wsConnected}><TimelinePage shots={shots} elements={elements} /></Chrome>} />
        <Route path="/deck" element={<Chrome wsConnected={wsConnected}><ReviewPage shots={shots} elements={elements} /></Chrome>} />
        <Route path="/mobile" element={<MobileReviewPage shots={shots} elements={elements} />} />
        {/* Default route */}
        <Route path="*" element={<Chrome wsConnected={wsConnected}><SetupPage shots={shots} /></Chrome>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
