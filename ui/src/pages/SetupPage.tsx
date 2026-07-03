/**
 * SetupPage — full setup flow against the T-27 endpoints (T-28).
 * State machine + API calls live in ui/src/setup/ (useSetupProject, api,
 * panels); this page just composes them. Layout CSS: SetupPage.css (T-26).
 */
import type { Shot } from '../../../app/src/types';
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

const DEFAULT_PROJECT = 'test_project';

export default function SetupPage({ shots }: { shots: Shot[] }) {
  const state = useSetupProject(DEFAULT_PROJECT, shots);

  return (
    <main className="content">
      <div className="page-head">
        <h1>Project setup</h1>
        <p>
          {state.mode === 'draft'
            ? 'New project — name it, paste the script, pick the voiceover.'
            : `${state.projectName} — align the script to the voiceover, lock the cast, start the run.`}
        </p>
        <span style={{ flex: 1 }}></span>
        {state.error && (
          <span
            className="chip"
            role="alert"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger-a35)', maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={state.error}
          >
            {state.error}
          </span>
        )}
        <DraftBar state={state} />
      </div>

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
            value={state.project?.config.styleBible ?? ''}
            placeholder="No style bible set for this project (config.styleBible)."
          />
          <p className="hint">Injected into every prompt-generation call, plus each line's element tags. Edit via project config.</p>
        </section>

        <CostPanel state={state} />
        <StartPanel state={state} />
      </div>
    </main>
  );
}
