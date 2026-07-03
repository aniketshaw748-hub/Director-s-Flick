/**
 * PreviewPlayer.tsx — React shell around PreviewEngine (T-25).
 *
 * Renders the A/B <video> pair + master-clock <audio> and the transport bar.
 * All high-frequency updates (timecode, playhead) bypass React state: the
 * engine emits 'time' at rAF rate and consumers patch the DOM directly.
 */
import { useEffect, useRef, useState } from 'react';
import { PreviewEngine } from './engine';
import type { PlayerSegment } from './engine';

interface PreviewPlayerProps {
  voSrc: string;
  segments: PlayerSegment[];
  /** engine instance handoff (playhead/scrub wiring); null on unmount */
  onEngine?: (engine: PreviewEngine | null) => void;
}

const videoStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  background: '#000',
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
}

export default function PreviewPlayer({ voSrc, segments, onEngine }: PreviewPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const vidARef = useRef<HTMLVideoElement>(null);
  const vidBRef = useRef<HTMLVideoElement>(null);
  const timecodeRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  const [placeholder, setPlaceholder] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    const vidA = vidARef.current;
    const vidB = vidBRef.current;
    if (!audio || !vidA || !vidB) return;

    const engine = new PreviewEngine(audio, vidA, vidB);
    engineRef.current = engine;

    const offs = [
      engine.on('play', () => setPlaying(true)),
      engine.on('pause', () => setPlaying(false)),
      engine.on('placeholder', (v) => setPlaceholder(v === 1)),
      engine.on('time', (t) => {
        if (timecodeRef.current) {
          timecodeRef.current.textContent = `${formatTime(t)} / ${formatTime(engine.duration)}`;
        }
      }),
    ];
    if (import.meta.env.DEV) {
      // measurement hook for T-25 verification: window.__previewEngine.getStats()
      (window as unknown as Record<string, unknown>).__previewEngine = engine;
    }
    onEngine?.(engine);

    return () => {
      offs.forEach((off) => off());
      onEngine?.(null);
      engineRef.current = null;
      engine.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setSegments(segments);
  }, [segments]);

  return (
    <div className="player-container">
      <div className="player-vid">
        {/* A/B pair: engine flips opacity/z-index at clip boundaries */}
        <video ref={vidARef} style={videoStyle} muted playsInline preload="auto" />
        <video ref={vidBRef} style={videoStyle} muted playsInline preload="auto" />
        <audio ref={audioRef} {...(voSrc ? { src: voSrc } : {})} preload="auto" />
        {segments.length === 0 && (
          <svg viewBox="0 0 44 44" width="88" height="88" opacity="0.3" style={{ position: 'relative', zIndex: 3 }}>
            <rect x="12" y="14" width="20" height="16" rx="7" fill="#1C2530" stroke="rgba(255,255,255,.18)" />
            <path d="M22 14v-4" stroke="rgba(255,255,255,.3)" strokeWidth="1.5" />
          </svg>
        )}
        {placeholder && (
          <div data-placeholder style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'var(--sp-2)', color: 'var(--text-3)' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 5l18 14" /></svg>
            <span style={{ fontSize: 'var(--fs-13)' }}>Clip missing — skipped (audio continues)</span>
          </div>
        )}
      </div>
      <div className="player-controls">
        <button
          className="play-btn"
          onClick={() => engineRef.current?.toggle()}
          disabled={segments.length === 0}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 2h3v10H3zM8 2h3v10H8z" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M4 2.5l8 4.5-8 4.5v-9z" /></svg>
          )}
        </button>
        <span className="timecode" ref={timecodeRef}>00:00.0 / 00:00.0</span>
      </div>
    </div>
  );
}
