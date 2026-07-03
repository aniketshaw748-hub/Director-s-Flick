import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import './index.css';
import SetupPage from './pages/SetupPage';
import TimelinePage from './pages/TimelinePage';
import MobileReviewPage from './pages/MobileReviewPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import { ProjectProvider, useProject } from './project/ProjectContext';
import MobileLink from './MobileLink';

interface AccountRow {
  name: string;
  balance: number | null;
  authenticated: boolean;
}

/** Real account list + cached balances (T-41: kill the demo money). */
function useAccounts(): AccountRow[] {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/accounts')
      .then((r) => r.json())
      .then(async (list: { name: string }[]) => {
        if (!Array.isArray(list)) return;
        const rows = await Promise.all(
          list.map((a) =>
            fetch(`/api/accounts/${encodeURIComponent(a.name)}/balance`)
              .then((r) => r.json())
              .then((b) => ({ name: a.name, balance: b?.balance ?? null, authenticated: !!b?.authenticated }))
              .catch(() => ({ name: a.name, balance: null, authenticated: false })),
          ),
        );
        if (alive) setAccounts(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return accounts;
}

function ProjectSwitcher() {
  const { projects, projectName, selectProject, shots, refreshProjects } = useProject();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="proj"
        style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-3)', cursor: 'pointer' }}
        onClick={() => {
          setOpen(!open);
          void refreshProjects();
        }}
        title="Switch project"
      >
        <span className="proj-name">{projectName || 'No project'}</span>
        <span className="proj-meta">
          {projectName ? `${shots.length} shots` : 'create one in Setup'} ▾
        </span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '40px', left: 0, width: '260px', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', padding: 'var(--sp-2)', zIndex: 100 }}>
          <div className="overline" style={{ padding: 'var(--sp-2) var(--sp-3)', fontSize: 'var(--fs-11)', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Projects</div>
          {projects.length === 0 && (
            <div style={{ padding: 'var(--sp-3)', color: 'var(--text-3)', fontSize: 'var(--fs-13)' }}>No projects yet.</div>
          )}
          {projects.map((p) => (
            <button
              key={p}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', textAlign: 'left', background: p === projectName ? 'var(--surface-2)' : 'transparent', color: p === projectName ? 'var(--lime)' : 'var(--text-1)', fontSize: 'var(--fs-14)' }}
              onClick={() => {
                selectProject(p);
                setOpen(false);
              }}
            >
              {p}
            </button>
          ))}
          <div style={{ height: '1px', background: 'var(--border-1)', margin: 'var(--sp-2) 0' }}></div>
          <button
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', color: 'var(--text-2)', fontSize: 'var(--fs-13)' }}
            onClick={() => {
              setOpen(false);
              navigate('/setup');
            }}
          >
            ＋ New project (Setup)
          </button>
        </div>
      )}
    </div>
  );
}

function AccountChip() {
  const accounts = useAccounts();
  const [open, setOpen] = useState(false);
  const primary = accounts.find((a) => a.authenticated) ?? accounts[0];

  return (
    <div style={{ position: 'relative' }}>
      <button className={`account-chip ${open ? 'active' : ''}`} onClick={() => setOpen(!open)}>
        <span className="initial">{primary ? primary.name[0].toUpperCase() : '—'}</span>
        <span className="name">{primary ? primary.name : 'No account'}</span>
        <span className="cr">{primary?.balance != null ? `${primary.balance.toFixed(1)} cr` : primary ? 'auth needed' : ''}</span>
        <svg className="caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 3.5 5 6.5 8 3.5" /></svg>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '50px', right: 0, width: '280px', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', padding: 'var(--sp-2)', zIndex: 100 }}>
          {accounts.length === 0 && (
            <div style={{ padding: 'var(--sp-3)', color: 'var(--text-3)', fontSize: 'var(--fs-13)' }}>
              No Higgsfield accounts configured. Add one below — it opens an interactive login on the server machine.
            </div>
          )}
          {accounts.map((a) => (
            <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', background: a.name === primary?.name ? 'var(--surface-2)' : 'transparent' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: 'var(--r-full)', background: 'var(--lime-a12)', border: '1px solid var(--lime-a20)', color: 'var(--lime)', display: 'grid', placeItems: 'center', fontWeight: 600 }}>{a.name[0].toUpperCase()}</div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 'var(--fs-14)', fontWeight: 500, color: 'var(--text-1)' }}>{a.name}</span>
                {a.authenticated ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', color: 'var(--lime)' }}>{a.balance != null ? `${a.balance.toFixed(1)} cr` : '— cr'}</span>
                ) : (
                  <span style={{ fontSize: 'var(--fs-12)', color: 'var(--danger)' }}>Session expired</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Base Chrome Layout
function Chrome({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const { wsConnected } = useProject();

  return (
    <div className="app">
      <aside className="rail">
        <div className="logo" title="Director's Flick">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3.5 1.8 12 7l-8.5 5.2z" fill="#121600" /></svg>
        </div>
        <Link to="/setup" className={`nav-btn ${loc.pathname === '/setup' ? 'active' : ''}`} title="Setup">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M3 6h9M16 6h1M3 14h3M10 14h7" /><circle cx="13.5" cy="6" r="2" /><circle cx="7.5" cy="14" r="2" /></svg>
        </Link>
        <Link to="/deck" className={`nav-btn ${loc.pathname === '/deck' ? 'active' : ''}`} title="Review">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}><rect x="5" y="4" width="12" height="13" rx="2.5" /><path d="M3 7v8a2.5 2.5 0 0 0 1.5 2.3" strokeLinecap="round" /></svg>
        </Link>
        <Link to="/timeline" className={`nav-btn ${loc.pathname === '/timeline' ? 'active' : ''}`} title="Timeline">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><path d="M3 5.5h14" /><rect x="3" y="9" width="8" height="3.5" rx="1.4" /><rect x="12.5" y="9" width="4.5" height="3.5" rx="1.4" /><path d="M3 16.5h14" /></svg>
        </Link>
        <div className="rail-spacer"></div>
        <div className="avatar">S</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <ProjectSwitcher />
          <div className="top-spacer"></div>
          <AccountChip />
          <MobileLink />
          <div className="conn" title={wsConnected ? 'Live connection to the server' : 'Server connection lost'}>
            <span className="dot" style={wsConnected ? undefined : { background: 'var(--danger)', boxShadow: '0 0 8px var(--danger-a35)' }}></span>
            {wsConnected ? 'LAN · live' : 'offline'}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

function App() {
  return (
    <ProjectProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<Chrome><SetupPage /></Chrome>} />
          <Route path="/timeline" element={<Chrome><TimelinePage /></Chrome>} />
          <Route path="/deck" element={<Chrome><ReviewPage /></Chrome>} />
          <Route path="/mobile" element={<MobileReviewPage />} />
          <Route path="/settings" element={<Chrome><SettingsPage /></Chrome>} />
          <Route path="/mobile/settings" element={<SettingsPage isMobile />} />
          {/* Default route */}
          <Route path="*" element={<Chrome><SetupPage /></Chrome>} />
        </Routes>
      </BrowserRouter>
    </ProjectProvider>
  );
}

export default App;
