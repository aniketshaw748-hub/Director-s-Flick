/**
 * OfflineBanner — global backend-unreachable strip (T-69).
 * Rendered by the desktop Chrome and the mobile page; pages gate their
 * "no project / create one" empties on the same context flag so a dead
 * backend never masquerades as an empty workspace.
 */
import { useProject } from './project/ProjectContext';

export default function OfflineBanner() {
  const { backendDown } = useProject();
  if (!backendDown) return null;
  return (
    <div
      role="alert"
      data-offline-banner
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-4)',
        background: 'var(--danger-a12)',
        borderBottom: '1px solid var(--danger-a35)',
        color: 'var(--danger)',
        fontSize: 'var(--fs-12)',
      }}
    >
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--danger)', flex: 'none' }}></span>
      Can't reach the backend — start it with <span className="mono">scripts\start-directors-flick.ps1</span> (or <span className="mono">npm run cli -- serve</span> in app/). Retrying automatically…
    </div>
  );
}
