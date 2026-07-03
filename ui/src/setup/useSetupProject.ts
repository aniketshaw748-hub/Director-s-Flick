/**
 * useSetupProject.ts — SetupPage state machine (T-28).
 *
 * Two modes:
 *  - 'view': an existing project — real shots/elements fetched from the
 *    server, plus a page-scoped WS subscription for sync/alignProgress/
 *    shotEvent pushes (independent of App.tsx's app-level socket so the
 *    setup flow works for freshly created projects too).
 *  - 'draft': a new project being assembled locally (name + script text +
 *    voiceover File). Nothing touches the server until createAndAlign() —
 *    see api.ts CAUTION about probe-created project shells.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ElementRef, Project, Shot } from '../../../app/src/types';
import {
  alignProject,
  createProject,
  getProjectState,
  isValidProjectName,
  listElements,
  startRun,
  stopRun,
  upsertElement,
} from './api';

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
  startGeneration: () => Promise<void>;
  stopGeneration: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSetupProject(initialProject: string, seedShots: Shot[]): SetupState {
  const [mode, setMode] = useState<'view' | 'draft'>('view');
  const [projectName, setProjectName] = useState(initialProject);
  const [project, setProject] = useState<Project | null>(null);
  const [shots, setShots] = useState<Shot[]>(seedShots);
  const [elements, setElements] = useState<ElementRef[]>([]);
  const [draft, setDraft] = useState<Draft>({ name: '', script: '', voFile: null });
  const [alignLines, setAlignLines] = useState<string[]>([]);
  const [aligning, setAligning] = useState(false);
  const [busy, setBusy] = useState<SetupBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  // the project the page-scoped WS is bound to; '' = none (draft mode)
  const wsProject = mode === 'view' ? projectName : '';
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!wsProject) return;
    try {
      const state = await getProjectState(wsProject);
      if (!aliveRef.current) return;
      setProject(state.project);
      setShots(state.shots);
      setElements(state.elements);
      setError(null);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [wsProject]);

  // initial + per-project fetch
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // page-scoped WS: sync + alignProgress + shotEvent for the viewed project
  useEffect(() => {
    if (!wsProject) return;
    const ws = new WebSocket(`ws://${window.location.host}/ws/?project=${encodeURIComponent(wsProject)}`);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'sync' && Array.isArray(data.shots)) {
          setShots(data.shots);
        } else if (data.type === 'shotEvent' && data.shotId) {
          setShots((prev) => prev.map((s) => (s.id === data.shotId ? { ...s, state: data.state } : s)));
        } else if (data.type === 'alignProgress' && typeof data.line === 'string') {
          setAlignLines((prev) => [...prev.slice(-30), data.line]);
        }
      } catch {
        /* non-JSON frame — ignore */
      }
    };
    return () => {
      setWsConnected(false);
      ws.close();
    };
  }, [wsProject]);

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
      const created = await createProject(draft.name, draft.script, draft.voFile);
      if (!aliveRef.current) return;
      // switch the page to the new project BEFORE aligning so the WS is
      // connected and alignProgress lines stream into the UI
      setProject(created);
      setShots([]);
      setElements([]);
      setAlignLines([]);
      setProjectName(draft.name);
      setMode('view');
      setBusy('align');
      setAligning(true);
      await alignProject(draft.name);
      if (!aliveRef.current) return;
      await refreshByName(draft.name);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) {
        setAligning(false);
        setBusy(null);
      }
    }

    async function refreshByName(name: string): Promise<void> {
      const state = await getProjectState(name);
      if (!aliveRef.current) return;
      setProject(state.project);
      setShots(state.shots);
      setElements(state.elements);
    }
  }, [draft]);

  const rerunAlign = useCallback(async (): Promise<void> => {
    if (!wsProject) return;
    setError(null);
    setBusy('align');
    setAligning(true);
    setAlignLines([]);
    try {
      await alignProject(wsProject);
      await refresh();
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) {
        setAligning(false);
        setBusy(null);
      }
    }
  }, [wsProject, refresh]);

  const addElement = useCallback(
    async (el: ElementRef): Promise<void> => {
      if (!wsProject) return;
      setError(null);
      setBusy('element');
      try {
        await upsertElement(wsProject, el);
        const els = await listElements(wsProject);
        if (aliveRef.current) setElements(els);
      } catch (e) {
        if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (aliveRef.current) setBusy(null);
      }
    },
    [wsProject],
  );

  const startGeneration = useCallback(async (): Promise<void> => {
    if (!wsProject) return;
    setError(null);
    setBusy('run');
    try {
      await startRun(wsProject);
      if (aliveRef.current) setRunning(true);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }, [wsProject]);

  const stopGeneration = useCallback(async (): Promise<void> => {
    if (!wsProject) return;
    try {
      await stopRun(wsProject);
      if (aliveRef.current) setRunning(false);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [wsProject]);

  return {
    mode,
    projectName,
    project,
    shots,
    elements,
    draft,
    alignLines,
    aligning,
    busy,
    error,
    running,
    wsConnected,
    startDraft,
    cancelDraft,
    patchDraft,
    createAndAlign,
    rerunAlign,
    addElement,
    startGeneration,
    stopGeneration,
    refresh,
  };
}
