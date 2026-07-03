import React from 'react';
import type { Shot } from '../../../app/src/types';

export default function SetupPage({ shots }: { shots: Shot[] }) {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
  };

  const totalLines = shots.length > 0 ? shots.length : 96;
  const totalDuration = shots.length > 0 ? shots[shots.length - 1].line.start + shots[shots.length - 1].line.targetDuration : 582;
  const estimatedCost = totalLines * 1.5 + totalLines * 6.25;

  return (
    <main className="content">
      <div className="page-head">
        <h1>Project setup</h1>
        <p>Align the script to the voiceover, lock the cast, start the run.</p>
      </div>

      {/* Left Column */}
      <div className="col">
        <div className="uploads">
          <section className="card upload-card">
            <div className="upload-head">
              <span className="overline">Script</span>
              <span className="spacer"></span>
              <span className="file">lighthouse.txt</span>
              <span className="meta">{totalLines} lines</span>
              <button className="btn btn-ghost">Replace</button>
            </div>
            <textarea className="script-box" spellCheck="false" defaultValue="The lighthouse on Grey Point had been dark for forty years. Until one autumn night, when something small washed ashore. It called itself Hapie, and it had been built to fix things. The door at the base of the tower hung open on one hinge. Inside, the dark smelled of salt and old rope. Somewhere above, a gull beat its wings against the glass. Hapie lit its lantern and started to climb..." />
          </section>

          <section className="card upload-card">
            <div className="upload-head">
              <span className="overline">Voiceover</span>
              <span className="spacer"></span>
              <span className="file">hapie_vo_final.wav</span>
              <span className="meta">{formatTime(totalDuration)} · 48 kHz</span>
              <button className="btn btn-ghost">Replace</button>
            </div>
            <div className="wave-box">
              <div className="wave" id="vo-wave" aria-hidden="true">
                {Array.from({ length: 115 }).map((_, i) => (
                  <i key={i} style={{ height: `${Math.max(10, Math.sin(i * 0.1) * 80 + Math.random() * 20)}%` }}></i>
                ))}
              </div>
              <div className="wave-meta"><span>00:00</span><span>{formatTime(totalDuration / 2)}</span><span>{formatTime(totalDuration)}</span></div>
            </div>
          </section>
        </div>

        <section className="card align-card">
          <div className="align-head">
            <h2>Alignment</h2>
            <span className="chip chip-lime"><span className="dot" style={{boxShadow: 'none'}}></span>aligned · stable-ts · 41 s</span>
            <span className="chip">{totalLines} lines</span>
            <span className="spacer"></span>
            <button className="btn btn-ghost">Re-run</button>
          </div>
          <div className="align-list align-fade">
            {shots.length > 0 ? (
              shots.map((shot: any, idx: number) => (
                <React.Fragment key={shot.id}>
                  <div className="align-row">
                    <span className="ln">L{(shot.lineIndex + 1).toString().padStart(2, '0')}</span>
                    <span className="txt">{shot.line.text}</span>
                    <span className="time">{formatTime(shot.line.start)} → {formatTime(shot.line.end)}</span>
                    <span className="dur">{shot.line.duration.toFixed(1)}s</span>
                  </div>
                  {shot.line.pauseAfter > 0 && (
                    <div className="pause">
                      <span className="rule"></span>
                      <span className="p">{shot.line.pauseAfter.toFixed(1)}s pause</span>
                      <span className="rule"></span>
                    </div>
                  )}
                </React.Fragment>
              ))
            ) : (
              // Mock fallback
              <>
                <div className="align-row"><span className="ln">L01</span><span className="txt">The lighthouse on Grey Point had been dark for forty years.</span><span className="time">00:00.0 → 00:05.8</span><span className="dur">5.8s</span></div>
                <div className="pause"><span className="rule"></span><span className="p">0.6s pause</span><span className="rule"></span></div>
                <div className="align-row"><span className="ln">L02</span><span className="txt">Until one autumn night, when something small washed ashore.</span><span className="time">00:06.4 → 00:11.9</span><span className="dur">5.5s</span></div>
                <div className="pause"><span className="rule"></span><span className="p">0.9s pause</span><span className="rule"></span></div>
              </>
            )}
          </div>
          <div className="align-foot">
            <span>{shots.length > 8 ? `…${shots.length - 8} more lines` : ''}</span>
            <span className="mono">total {formatTime(totalDuration)}</span>
          </div>
        </section>
      </div>

      {/* Right Column */}
      <div className="col">
        <section className="card panel">
          <div className="panel-head">
            <span className="overline">Elements</span>
            <span className="chip">3</span>
            <span className="spacer"></span>
            <button className="btn btn-ghost" style={{color: 'var(--lime)'}}>＋ New element</button>
          </div>

          <div className="el-row">
            <div className="el-thumb" style={{background: 'linear-gradient(180deg,#141C26,#0A0E14)'}}>
              <svg viewBox="0 0 44 44" width="44" height="44"><rect x="12" y="14" width="20" height="16" rx="7" fill="#1C2530" stroke="rgba(255,255,255,.18)"/><circle cx="19" cy="22" r="2.4" fill="#C6FF4D"/><circle cx="25" cy="22" r="2.4" fill="#C6FF4D"/><path d="M22 14v-4" stroke="rgba(255,255,255,.3)" strokeWidth="1.5"/><circle cx="22" cy="8" r="1.8" fill="#C6FF4D" opacity=".8"/></svg>
            </div>
            <div className="el-info">
              <span className="at-chip">@Hapie-ai-bot</span>
              <div className="meta"><span className="el-kind">Character</span> · 6 refs · in 84 lines</div>
            </div>
            <button className="btn btn-ghost">Edit</button>
          </div>

          <div className="el-row">
            <div className="el-thumb" style={{background: 'radial-gradient(80% 70% at 50% 42%,rgba(255,180,84,.35),rgba(255,180,84,0) 65%),linear-gradient(180deg,#18222E,#0A0D12)'}}>
              <svg viewBox="0 0 44 44" width="44" height="44"><circle cx="22" cy="19" r="9" fill="none" stroke="rgba(255,196,107,.55)" strokeWidth="1.4"/><circle cx="22" cy="19" r="5" fill="none" stroke="rgba(255,196,107,.35)" strokeWidth="1"/><path d="M8 36 14 26h16l6 10" fill="rgba(6,8,11,.65)"/></svg>
            </div>
            <div className="el-info">
              <span className="at-chip">@Lighthouse-room</span>
              <div className="meta"><span className="el-kind">Environment</span> · 3 refs · in 41 lines</div>
            </div>
            <button className="btn btn-ghost">Edit</button>
          </div>

          <button className="el-create">
            <span className="plus">＋</span>
            <span><b>Create element</b><div className="sub">Upload references — or promote any approved frame from Review.</div></span>
          </button>
        </section>

        <section className="card panel">
          <div className="panel-head"><span className="overline">Style bible</span></div>
          <textarea className="bible" spellCheck="false" defaultValue="Painterly cinematic realism. Muted teal shadows, warm amber key light from practical sources (lantern, lamp lens). 35mm, grounded camera, gentle handheld. Fine film grain, soft bloom on highlights. Never: text, watermarks, cartoon outlines, neon color." />
          <p className="hint">Injected into every prompt-generation call, plus each line’s element tags.</p>
        </section>

        <section className="card panel">
          <div className="panel-head"><span className="overline">Models &amp; cost</span><span className="spacer"></span><button className="btn btn-ghost">Change</button></div>
          <div>
            <div className="cost-row model"><span>Image · Nano Banana 2</span><span className="v">1.5 cr / image</span></div>
            <div className="cost-row model"><span>Video · Kling 3.0 std, sound off</span><span className="v">6.25 cr / 5 s</span></div>
            <div className="cost-div"></div>
            <div className="cost-row"><span>{totalLines} images + ~20% re-rolls</span><span className="v">{(totalLines * 1.5 * 1.2).toFixed(1)} cr</span></div>
            <div className="cost-row"><span>{totalLines} clips</span><span className="v">{(totalLines * 6.25).toFixed(1)} cr</span></div>
            <div className="cost-div"></div>
            <div className="cost-total">
              <span className="label">Estimated run</span>
              <span><span className="big">≈ {estimatedCost.toFixed(0)} cr</span> <span className="usd">${(estimatedCost * 0.06).toFixed(2)}</span></span>
            </div>
          </div>
          <div>
            <div className="balance-bar" title={`${estimatedCost.toFixed(0)} of 2,025 credits`}><span className="used" style={{width: `${(estimatedCost/2025)*100}%`}}></span><span className="left"></span></div>
            <div className="balance-meta" style={{marginTop: '6px'}}><span>after run ≈ {(2025 - estimatedCost).toFixed(0)} cr</span><span>balance 2,025.0 cr</span></div>
          </div>
          <p className="hint">Every job is pre-flighted with <span className="mono">get_cost</span> and written to this account’s ledger.</p>
        </section>

        <div className="start">
          <button className="btn btn-primary">Start generation</button>
          <span className="cap">Queues the first 5 images now — review opens in about a minute.</span>
        </div>
      </div>
    </main>
  );
}
