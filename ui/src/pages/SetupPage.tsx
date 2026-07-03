/**
 * SetupPage — full setup flow against the T-27 endpoints (T-28; T-41: rides
 * the app-level ProjectContext, page-level create/align progress banner,
 * routes to Review once generation starts).
 */
import { useNavigate } from 'react-router-dom';
import { useSetupProject } from '../setup/useSetupProject';
import {
  AlignCard,
  CostPanel,
  DraftBar,
  ElementsPanel,
  ScriptCard,
  StartPanel,
  VoiceoverCard,
} from '../setup/panels';
import './SetupPage.css';

export default function SetupPage() {
  const base = useSetupProject();
  const navigate = useNavigate();
  const state = base;

  const busyBanner =
    base.busy === 'create'
      ? 'Uploading voiceover & creating the project…'
      : base.aligning
        ? `Aligning script to voiceover… ${base.alignLines.length > 0 ? base.alignLines[base.alignLines.length - 1] : ''}`
        : null;

  return (
    <main className="content">
      <div className="page-head">
        <h1>Project setup</h1>
        <p>
          {base.mode === 'draft'
            ? 'New project — name it, paste the script, pick the voiceover.'
            : base.projectName
              ? `${base.projectName} — align the script to the voiceover, lock the cast, start the run.`
              : 'No project yet — create your first one.'}
        </p>
        <span style={{ flex: 1 }}></span>
        {base.error && (
          <span
            className="chip"
            role="alert"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger-a35)', maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={base.error}
          >
            {base.error}
          </span>
        )}
        <DraftBar state={state} />
      </div>

      {busyBanner && (
        <div
          role="status"
          style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)', background: 'var(--lime-a08)', border: '1px solid var(--lime-a20)', borderRadius: 'var(--r-md)', color: 'var(--text-1)', fontSize: 'var(--fs-13)' }}
        >
          <span className="dot" style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--lime)', boxShadow: '0 0 8px var(--lime-a35)' }}></span>
          <span className="mono">{busyBanner}</span>
        </div>
      )}

      <div className="col">
        <div className="uploads">
          <ScriptCard state={state} />
          <VoiceoverCard state={state} />
        </div>
        <AlignCard state={state} />
      </div>

      <div className="col">
        <ElementsPanel state={state} />

        <section className="card panel">
          <div className="panel-head"><span className="overline">Style bible</span></div>
          <textarea
            className="bible"
            spellCheck={false}
            readOnly
            value={base.project?.config.styleBible ?? ''}
            placeholder="No style bible set for this project (config.styleBible)."
          />
          <p className="hint">Injected into every prompt-generation call, plus each line's element tags. Edit via project config.</p>
        </section>

        <CostPanel state={state} />
        <StartPanel state={state} onStarted={() => navigate('/deck')} />
      </div>
    </main>
  );
}
