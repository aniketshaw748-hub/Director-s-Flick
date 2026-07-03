import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProject } from '../project/ProjectContext';
import type { PipelineConfig, ProviderName } from '../../../app/src/types';
import './SettingsPage.css';

interface SettingsPageProps {
  isMobile?: boolean;
}

export default function SettingsPage({ isMobile }: SettingsPageProps) {
  const { project } = useProject();
  const navigate = useNavigate();
  
  const [config, setConfig] = useState<Partial<PipelineConfig>>({});
  const [notReady, setNotReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!project?.id) return;
    setLoading(true);
    fetch(`/api/projects/${encodeURIComponent(project.id)}/config`)
      .then(res => {
        if (!res.ok) throw new Error('Backend not ready');
        return res.json();
      })
      .then(data => {
        setConfig(data);
        setNotReady(false);
      })
      .catch(() => {
        setNotReady(true);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [project?.id]);

  const handleSave = async () => {
    if (!project?.id || notReady) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (!res.ok) throw new Error('Failed to save');
      if (isMobile) navigate('/mobile'); // Go back to mobile review
      // For desktop, it might just show a success state or just stay
    } catch (e) {
      console.error(e);
      alert("Failed to save. Backend might not be ready.");
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (update: Partial<PipelineConfig>) => {
    setConfig(prev => ({ ...prev, ...update }));
  };

  const updateModel = (key: 'image' | 'video' | 'videoMode', value: string) => {
    setConfig(prev => ({
      ...prev,
      models: {
        ...(prev.models || { image: 'nano_banana_2', video: 'kling3_0', videoMode: 'std' }),
        [key]: value
      }
    }));
  };

  if (!project) {
    return (
      <div className={`settings-page ${isMobile ? 'mobile' : 'desktop'}`}>
        <div className="not-ready-state">
          <p>No project selected.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`settings-page ${isMobile ? 'mobile' : 'desktop'}`}>
        <div className="not-ready-state">
          <p>Loading settings...</p>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (notReady) {
      return (
        <div className="not-ready-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <p>Settings backend is currently under construction (T-51).</p>
          <p style={{ fontSize: 'var(--fs-12)', marginTop: 'var(--sp-2)' }}>Please try again later.</p>
        </div>
      );
    }

    return (
      <>
        {/* Models Section */}
        <section className="settings-section">
          <h2 className="settings-section-title">Models & Dimensions</h2>
          <div className={isMobile ? "settings-field" : "settings-grid-2"}>
            <div className="settings-field">
              <label>Image Model</label>
              <select value={config.models?.image || 'nano_banana_2'} onChange={e => updateModel('image', e.target.value)}>
                <option value="nano_banana_2">Nano Banana 2</option>
                <option value="kling3_0">Kling 3.0 Pro</option>
              </select>
              <span className="hint">Base model for text-to-image</span>
            </div>
            <div className="settings-field">
              <label>Video Model</label>
              <select value={config.models?.video || 'kling3_0'} onChange={e => updateModel('video', e.target.value)}>
                <option value="kling3_0">Kling 3.0</option>
                <option value="kling2_5_turbo_pro">Kling 2.5 Turbo Pro</option>
              </select>
              <span className="hint">Base model for image-to-video</span>
            </div>
            <div className="settings-field">
              <label>Video Mode</label>
              <select value={config.models?.videoMode || 'std'} onChange={e => updateModel('videoMode', e.target.value)}>
                <option value="std">Standard (std)</option>
                <option value="pro">Professional (pro)</option>
                <option value="4k">4K Ultra (4k)</option>
              </select>
            </div>
            <div className="settings-field">
              <label>Aspect Ratio</label>
              <select value={config.aspectRatio || '16:9'} onChange={e => updateConfig({ aspectRatio: e.target.value })}>
                <option value="16:9">16:9 (Landscape)</option>
                <option value="9:16">9:16 (Portrait)</option>
                <option value="1:1">1:1 (Square)</option>
              </select>
            </div>
          </div>
          <div className="settings-field" style={{ paddingTop: 'var(--sp-2)' }}>
            <label style={{ justifyContent: 'flex-start', gap: 'var(--sp-3)', cursor: 'pointer' }}>
              <input type="checkbox" checked={config.soundOff !== false} onChange={e => updateConfig({ soundOff: e.target.checked })} style={{ width: '18px', height: '18px' }} />
              <span>Mute video generations</span>
            </label>
            <span className="hint" style={{ marginLeft: '30px' }}>Reduces cost. Audio is mixed at export.</span>
          </div>
        </section>

        {/* Providers Section */}
        <section className="settings-section">
          <h2 className="settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            Providers 
            <span style={{ display: 'inline-flex', alignItems: 'center', height: '20px', padding: '0 6px', borderRadius: 'var(--r-sm)', fontSize: '10px', fontWeight: 600, background: 'var(--lime-a12)', color: 'var(--lime)', border: '1px solid var(--lime-a20)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Advanced
            </span>
          </h2>
          <div className={isMobile ? "settings-field" : "settings-grid-3"}>
            <div className="settings-field">
              <label>Default Provider</label>
              <select value={config.provider || 'mock'} onChange={e => updateConfig({ provider: e.target.value as ProviderName })}>
                <option value="mock">Mock (Local)</option>
                <option value="higgsfield-cli">Higgsfield CLI</option>
                <option value="fal">Fal.ai</option>
                <option value="replicate">Replicate</option>
              </select>
            </div>
            <div className="settings-field">
              <label>Image Override</label>
              <select value={config.imageProvider || ''} onChange={e => updateConfig({ imageProvider: e.target.value ? (e.target.value as ProviderName) : undefined })}>
                <option value="">Default</option>
                <option value="mock">Mock (Local)</option>
                <option value="higgsfield-cli">Higgsfield CLI</option>
              </select>
            </div>
            <div className="settings-field">
              <label>Video Override</label>
              <select value={config.videoProvider || ''} onChange={e => updateConfig({ videoProvider: e.target.value ? (e.target.value as ProviderName) : undefined })}>
                <option value="">Default</option>
                <option value="mock">Mock (Local)</option>
                <option value="higgsfield-cli">Higgsfield CLI</option>
                <option value="fal">Fal.ai</option>
                <option value="replicate">Replicate</option>
              </select>
            </div>
          </div>
        </section>

        {/* Prompt Engine Section */}
        <section className="settings-section">
          <h2 className="settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            Prompt Engine
            <span style={{ display: 'inline-flex', alignItems: 'center', height: '20px', padding: '0 6px', borderRadius: 'var(--r-sm)', fontSize: '10px', fontWeight: 600, background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border-1)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Experimental
            </span>
          </h2>
          <div className={isMobile ? "settings-field" : "settings-grid-2"}>
            <div className="settings-field">
              <label>Engine Backend</label>
              <select 
                value={config.promptBackend || 'template'} 
                onChange={e => updateConfig({ promptBackend: e.target.value as 'template' | 'llm' })}
              >
                <option value="template">Template (Deterministic)</option>
                <option value="llm">LLM (Anthropic API)</option>
              </select>
              <span className="hint">LLM mode uses Claude to write detailed prompts. Requires ANTHROPIC_API_KEY on the server. Falls back to Template on any error.</span>
            </div>
            <div className="settings-field">
              <label>LLM Model</label>
              <input 
                type="text" 
                value={config.llmModel || 'claude-opus-4-8'} 
                onChange={e => updateConfig({ llmModel: e.target.value })}
                disabled={config.promptBackend !== 'llm'}
                style={{ opacity: config.promptBackend !== 'llm' ? 0.5 : 1 }}
              />
              <span className="hint">Anthropic model to use. Default is claude-opus-4-8.</span>
            </div>
          </div>
        </section>

        {/* Style Bible Section */}
        <section className="settings-section">
          <h2 className="settings-section-title">Style Bible</h2>
          <div className="settings-field">
            <label>Global Prompts <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 'var(--fs-12)' }}>Injected</span></label>
            <textarea 
              className="settings-bible-editor" 
              spellCheck="false" 
              placeholder="Enter universal styling prompts, negative prompts..."
              value={config.styleBible || ''}
              onChange={e => updateConfig({ styleBible: e.target.value })}
            />
            <div className="preset-pills">
              <button className="preset-pill" onClick={() => updateConfig({ styleBible: 'Painterly cinematic realism. Muted teal shadows, warm amber key light from practical sources (lantern, lamp lens). 35mm, grounded camera, gentle handheld. Fine film grain, soft bloom on highlights. Never: text, watermarks, cartoon outlines, neon color.' })}>
                Teal & Orange
              </button>
              <button className="preset-pill" onClick={() => updateConfig({ styleBible: '35mm film still, cinematic lighting, 8k resolution, ultra detailed. Masterpiece. Negative: low quality, blurry, deformed.' })}>
                35mm Film
              </button>
              <button className="preset-pill" onClick={() => updateConfig({ styleBible: 'Dark fantasy aesthetic. Gloomy atmosphere, high contrast, dramatic shadows. Detailed textures, somber mood.' })}>
                Dark Fantasy
              </button>
            </div>
          </div>
        </section>

        {/* Cost Preview Section */}
        <section className="settings-section">
          <h2 className="settings-section-title">Billing & Costs</h2>
          <div className="settings-cost-card">
            <div className="settings-cost-card-head">
              <h3>Rates Preview</h3>
              <span style={{ display: 'inline-flex', alignItems: 'center', height: '20px', padding: '0 6px', borderRadius: 'var(--r-sm)', fontSize: '10px', fontWeight: 600, background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border-1)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Per generation
              </span>
            </div>
            <div>
              <div className="settings-cost-row">
                <div className="item">
                  <span>Nano Banana 2</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', height: '20px', padding: '0 6px', borderRadius: 'var(--r-sm)', fontSize: '10px', fontWeight: 600, background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border-1)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Image</span>
                </div>
                <div><span className="v">1.5 cr</span> <span className="usd">≈ $0.09</span></div>
              </div>
              <div className="settings-cost-row">
                <div className="item">
                  <span>Kling 3.0 (std)</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', height: '20px', padding: '0 6px', borderRadius: 'var(--r-sm)', fontSize: '10px', fontWeight: 600, background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border-1)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Video</span>
                </div>
                <div><span className="v">6.25 cr</span> <span className="usd">≈ $0.37</span></div>
              </div>
              <div className="settings-cost-row" style={{ background: 'var(--surface-2)', padding: 'var(--sp-2) var(--sp-2)', marginTop: 'var(--sp-2)', borderRadius: 'var(--r-md)', borderBottom: 'none' }}>
                <div className="item">
                  <span style={{ color: 'var(--text-1)' }}>Fal.ai Fallback</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', height: '20px', padding: '0 6px', borderRadius: 'var(--r-sm)', fontSize: '10px', fontWeight: 600, background: 'var(--bg-1)', color: 'var(--text-2)', border: '1px solid var(--border-1)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Video</span>
                </div>
                <div><span className="v" style={{ color: 'var(--lime)' }}>$0.35</span></div>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  };

  if (isMobile) {
    return (
      <div className="settings-page mobile">
        <header className="topbar">
          <button className="btn-nav" title="Back" onClick={() => navigate('/mobile')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
          <div className="top-title">Settings</div>
          <button className="btn-save" onClick={handleSave} disabled={saving || notReady}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </header>
        <main className="content">
          {renderContent()}
        </main>
      </div>
    );
  }

  // Desktop view
  return (
    <div className="settings-page desktop">
      <div className="settings-container">
        <div className="page-head">
          <div>
            <h1>Project Settings</h1>
            <p>Configure generation models, providers, and global styles for {project.name}.</p>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary" onClick={() => navigate('/deck')} disabled={saving}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || notReady}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
        {renderContent()}
      </div>
    </div>
  );
}
