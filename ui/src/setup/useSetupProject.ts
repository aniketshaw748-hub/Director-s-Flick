/**
 * useSetupProject.ts — SetupPage state machine (T-28, reworked for T-41).
 *
 * Project identity/state/WS now live in the app-level ProjectContext (ONE
 * socket, every page follows the selected project). This hook keeps only the
 * setup-flow specifics: the new-project draft, create→align orchestration,
 * align progress lines (via ctx.subscribe), element registration, run
 * start/stop. Creating a project switches the WHOLE APP to it via
 * ctx.selectProject — that is the T-40 CRITICAL-1 fix in action.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ElementRef, Project, Shot } from '../../../app/src/types';
import { useProject } from '../project/ProjectContext';
import { alignProject, createProject, isValidProjectName, startRun, stopRun, upsertElement } from './api';

export interface Draft {
  name: string;
  script: string;
  voFile: File | null;
}

export type SetupBusy = 'create' | 'align' | 'run' | 'element' | null;

export interface SetupState {
  mode: 'view' | 'draft';
  projectName: string;
  project: Project | null;
  shots: Shot[];
  elements: ElementRef[];
  draft: Draft;
  alignLines: string[];
  aligning: boolean;
  busy: SetupBusy;
  error: string | null;
  running: boolean;
  wsConnected: boolean;
  startDraft: () => void;
  cancelDraft: () => void;
  patchDraft: (patch: Partial<Draft>) => void;
  createAndAlign: () => Promise<void>;
  rerunAlign: () => Promise<void>;
  addElement: (el: ElementRef) => Promise<void>;
  /** returns true when the run actually started (caller may navigate) */
  startGeneration: () => Promise<boolean>;
  stopGeneration: () => Promise<void>;
}

export function useSetupProject(): SetupState {
  const ctx = useProject();
  const [mode, setMode] = useState<'view' | 'draft'>('view');
  const [draft, setDraft] = useState<Draft>({ name: '', script: '', voFile: null });
  const [alignLines, setAlignLines] = useState<string[]>([]);
  const [aligning, setAligning] = useState(false);
  const [busy, setBusy] = useState<SetupBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // align progress lines ride the app-level socket
  useEffect(
    () =>
      ctx.subscribe((msg) => {
        if (msg.type === 'alignProgress' && typeof msg.line === 'string') {
          setAlignLines((prev) => [...prev.slice(-30), msg.line as string]);
        }
      }),
    [ctx.subscribe],
  );

  const startDraft = useCallback(() => {
    setMode('draft');
    setDraft({ name: '', script: '', voFile: null });
    setAlignLines([]);
    setError(null);
  }, []);

  const cancelDraft = useCallback(() => {
    setMode('view');
    setError(null);
  }, []);

  const patchDraft = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const createAndAlign = useCallback(async (): Promise<void> => {
    if (!isValidProjectName(draft.name)) {
      setError('Project name must be letters/numbers/_/- only');
      return;
    }
    if (!draft.script.trim()) {
      setError('Script text is required');
      return;
    }
    if (!draft.voFile) {
      setError('Choose a voiceover audio file');
      return;
    }
    setError(null);
    setBusy('create');
    try {
      await createProject(draft.name, draft.script, draft.voFile);
      if (!aliveRef.current) return;
      // switch the WHOLE APP to the new project (context owns state + WS)
      ctx.selectProject(draft.name);
      void ctx.refreshProjects();
      setAlignLines([]);
      setMode('view');
      setBusy('align');
      setAligning(true);
      await alignProject(draft.name);
      if (aliveRef.current) await ctx.refreshState();
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) {
        setAligning(false);
        setBusy(null);
      }
    }
  }, [draft, ctx]);

  const rerunAlign = useCallback(async (): Promise<void> => {
    if (!ctx.projectName) return;
    setError(null);
    setBusy('align');
    setAligning(true);
    setAlignLines([]);
    try {
      await alignProject(ctx.projectName);
      await ctx.refreshState();
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) {
        setAligning(false);
        setBusy(null);
      }
    }
  }, [ctx]);

  const addElement = useCallback(
    async (el: ElementRef): Promise<void> => {
      if (!ctx.projectName) return;
      setError(null);
      setBusy('element');
      try {
        await upsertElement(ctx.projectName, el);
        await ctx.refreshState();
      } catch (e) {
        if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (aliveRef.current) setBusy(null);
      }
    },
    [ctx],
  );

  const startGeneration = useCallback(async (): Promise<boolean> => {
    if (!ctx.projectName) return false;
    setError(null);
    setBusy('run');
    try {
      await startRun(ctx.projectName);
      if (aliveRef.current) setRunning(true);
      return true;
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }, [ctx]);

  const stopGeneration = useCallback(async (): Promise<void> => {
    if (!ctx.projectName) return;
    try {
      await stopRun(ctx.projectName);
      if (aliveRef.current) setRunning(false);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [ctx]);

  return {
    mode,
    projectName: ctx.projectName,
    project: ctx.project,
    shots: ctx.shots,
    elements: ctx.elements,
    draft,
    alignLines,
    aligning,
    busy,
    error,
    running,
    wsConnected: ctx.wsConnected,
    startDraft,
    cancelDraft,
    patchDraft,
    createAndAlign,
    rerunAlign,
    addElement,
    startGeneration,
    stopGeneration,
  };
}
