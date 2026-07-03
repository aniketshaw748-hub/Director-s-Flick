import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import './index.css';
import SetupPage from './pages/SetupPage';
import TimelinePage from './pages/TimelinePage';
import MobileReviewPage from './pages/MobileReviewPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import { ProjectProvider, useProject } from './project/ProjectContext';
import MobileLink from './MobileLink';
import OfflineBanner from './OfflineBanner';

interface AccountRow {
  name: string;
  balance: number | null;
  authenticated: boolean;
}

/** Real account list + cached balances (T-41: kill the demo money).
 * Exposes refresh() so the switcher can reload after adding an account (T-87). */
function useAccounts(): { accounts: AccountRow[]; refresh: () => void } {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const load = useCallback(() => {
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
        setAccounts(rows);
      })
      .catch(() => {});
  }, []);
  useEffect(() => load(), [load]);
  return { accounts, refresh: load };
}

function ProjectSwitcher() {
  const { projects, projectName, selectProject, shots, refreshProjects, backendDown } = useProject();
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
          {projectName ? `${shots.length} shots` : backendDown ? 'backend offline' : 'create one in Setup'} ▾
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
  const { accounts, refresh } = useAccounts();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const primary = accounts.find((a) => a.authenticated) ?? accounts[0];

  // T-87: kick off the interactive server-side `higgsfield auth login` (POST
  // returns immediately), then poll status until the login completes and reload.
  async function handleAdd() {
    const name = newName.trim();
    if (!name || pendingName) return;
    setError(null);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        // T-69/T-71: a 4xx/5xx is a real error to surface, not "backend down".
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Add failed (HTTP ${res.status}).`);
        return;
      }
      setNewName('');
      setPendingName(name);
      pollStatus(name, 0);
    } catch {
      setError('Could not reach the server — is it running?');
    }
  }

  function pollStatus(name: string, tries: number) {
    window.setTimeout(async () => {
      try {
        const s = (await fetch(`/api/accounts/${encodeURIComponent(name)}/status`).then((r) => r.json())) as {
          authenticated?: boolean;
        };
        if (s?.authenticated) {
          setPendingName(null);
          refresh();
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (tries < 60) pollStatus(name, tries + 1);
      else {
        setPendingName(null);
        setError(`Timed out waiting for "${name}" to finish logging in.`);
      }
    }, 3000);
  }

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
              No Higgsfield accounts configured. Add one below — the login opens in the server's terminal.
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

          {/* T-87: add-account control — present in BOTH empty and populated states */}
          <div style={{ height: '1px', background: 'var(--border-1)', margin: 'var(--sp-2) 0' }}></div>
          {pendingName ? (
            <div style={{ padding: 'var(--sp-3)', color: 'var(--text-2)', fontSize: 'var(--fs-12)', lineHeight: 1.4 }}>
              Login started for <strong style={{ color: 'var(--text-1)' }}>{pendingName}</strong>. Complete the Higgsfield
              login prompt in the <strong>server's terminal</strong> — this updates automatically when it finishes.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--sp-2)', padding: 'var(--sp-3)', alignItems: 'center' }}>
              <input
                style={{ flex: 1, minWidth: 0, padding: 'var(--sp-2) var(--sp-3)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-md)', color: 'var(--text-1)', fontSize: 'var(--fs-13)' }}
                value={newName}
                placeholder="new account name"
                aria-label="new account name"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
              />
              <button
                style={{ padding: 'var(--sp-2) var(--sp-3)', borderRadius: 'var(--r-md)', background: 'var(--lime)', color: '#121600', fontSize: 'var(--fs-13)', fontWeight: 600, opacity: newName.trim() ? 1 : 0.45, cursor: newName.trim() ? 'pointer' : 'default' }}
                disabled={!newName.trim()}
                onClick={() => void handleAdd()}
              >
                Add
              </button>
            </div>
          )}
          {error && (
            <div style={{ padding: '0 var(--sp-3) var(--sp-3)', color: 'var(--danger)', fontSize: 'var(--fs-12)' }}>{error}</div>
          )}
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
        <OfflineBanner />
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
