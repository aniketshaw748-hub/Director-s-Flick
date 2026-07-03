/**
 * MobileLink — phone-onboarding popover (T-48): QR code + URL for the mobile
 * review page at http://<lan-ip>:<ui-port>/mobile?project=<current>.
 * LAN IP comes from GET /api/lan-info (browsers can't enumerate NICs).
 */
import { useEffect, useMemo, useState } from 'react';
import { useProject } from './project/ProjectContext';
import { encodeQr, qrToSvg } from './qr';

export default function MobileLink() {
  const { projectName } = useProject();
  const [open, setOpen] = useState(false);
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/lan-info')
      .then((r) => r.json())
      .then((d) => {
        if (alive && typeof d?.lanIp === 'string') setLanIp(d.lanIp);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const url = useMemo(() => {
    if (!lanIp || !projectName) return null;
    const port = window.location.port || '5173';
    return `http://${lanIp}:${port}/mobile?project=${encodeURIComponent(projectName)}`;
  }, [lanIp, projectName]);

  const qrSrc = useMemo(() => {
    if (!url) return null;
    try {
      return `data:image/svg+xml;utf8,${encodeURIComponent(qrToSvg(encodeQr(url), 4))}`;
    } catch {
      return null;
    }
  }, [url]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="conn"
        style={{ cursor: 'pointer' }}
        title="Review on your phone — QR code"
        onClick={() => setOpen(!open)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <rect x="7" y="2" width="10" height="20" rx="2.5" />
          <path d="M11 18.5h2" />
        </svg>
        Phone
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '46px', right: 0, width: '260px', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', padding: 'var(--sp-4)', zIndex: 100 }}>
          <div className="overline" style={{ fontSize: 'var(--fs-11)', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Review on your phone
          </div>
          {qrSrc && url ? (
            <>
              <img src={qrSrc} alt={`QR code for ${url}`} style={{ width: '100%', borderRadius: 'var(--r-md)', background: '#fff' }} data-qr-url={url} />
              <div className="mono" style={{ fontSize: 'var(--fs-11)', color: 'var(--text-2)', wordBreak: 'break-all' }}>{url}</div>
              <button
                className="btn btn-secondary"
                style={{ height: '32px', fontSize: 'var(--fs-12)' }}
                onClick={() => {
                  void navigator.clipboard?.writeText(url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? 'Copied ✓' : 'Copy link'}
              </button>
              <p className="hint" style={{ fontSize: 'var(--fs-11)', color: 'var(--text-3)' }}>
                Same Wi-Fi as this PC. If the phone can't connect, run <span className="mono">app/scripts/allow-lan.ps1</span> once (as admin) to open the firewall.
              </p>
            </>
          ) : (
            <p className="hint" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)' }}>
              {!projectName
                ? 'Select a project first.'
                : lanIp === null
                  ? 'No LAN address found — is this PC on a network? (Backend must be running for /api/lan-info.)'
                  : 'Preparing link…'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
