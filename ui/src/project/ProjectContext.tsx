/**
 * ProjectContext — app-level project state (T-41, from T-40 CRITICAL 1).
 *
 * ONE source of truth for which project the app is looking at, its
 * {project, shots, elements} state, and ONE WebSocket per selected project.
 * Every page/fetch/media URL derives from this — no hardcoded project names
 * anywhere below the provider.
 *
 * Raw WS messages (alignProgress, exportProgress, …) fan out to subscribers
 * via subscribe(); shots stay in sync via the 2s `sync` broadcast plus
 * immediate `shotEvent` patches.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementRef, Project, Shot } from '../../../app/src/types';

const STORAGE_KEY = 'directors-flick.project';

export type ProjectWsMessage = { type: string } & Record<string, unknown>;

export interface ProjectContextValue {
  /** all project folder names known to the server */
  projects: string[];
  refreshProjects: () => Promise<string[]>;
  /** selected project name; '' = none selected yet */
  projectName: string;
  selectProject: (name: string) => void;
  project: Project | null;
  shots: Shot[];
  elements: ElementRef[];
  wsConnected: boolean;
  /** re-fetch {project, shots, elements} for the selected project */
  refreshState: () => Promise<void>;
  /** raw WS message stream for the selected project */
  subscribe: (fn: (msg: ProjectWsMessage) => void) => () => void;
  /** true once the initial projects fetch has settled (success OR failure) —
   *  lets pages show "loading" instead of a flash of misleading empty state */
  initialized: boolean;
  /** true when the backend is unreachable at the network level (T-69) —
   *  pages must NOT render "no projects, create one" empties in this state */
  backendDown: boolean;
}

const Ctx = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProject must be used inside <ProjectProvider>');
  return v;
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');
  const [project, setProject] = useState<Project | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [elements, setElements] = useState<ElementRef[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [backendDown, setBackendDown] = useState(false);
  const subscribers = useRef(new Set<(msg: ProjectWsMessage) => void>());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshProjects = useCallback(async (): Promise<string[]> => {
    try {
      const list = await fetch('/api/projects').then((r) => r.json());
      if (Array.isArray(list) && aliveRef.current) {
        setBackendDown(false);
        setProjects(list);
        return list;
      }
    } catch {
      // network-level failure — server down; keep last list, flag it
      if (aliveRef.current) setBackendDown(true);
    }
    return [];
  }, []);

  const selectProject = useCallback((name: string) => {
    localStorage.setItem(STORAGE_KEY, name);
    setProjectName(name);
    setProject(null);
    setShots([]);
    setElements([]);
  }, []);

  // initial: ?project= URL override (mobile/LAN devices don't share the
  // desktop's localStorage — a shareable link must carry the project), then
  // last saved selection (validated), else first project
  useEffect(() => {
    void (async () => {
      const list = await refreshProjects();
      const fromUrl = new URLSearchParams(window.location.search).get('project') ?? '';
      const saved = localStorage.getItem(STORAGE_KEY) ?? '';
      const pick = list.includes(fromUrl) ? fromUrl : list.includes(saved) ? saved : (list[0] ?? '');
      if (pick) {
        localStorage.setItem(STORAGE_KEY, pick);
        setProjectName(pick);
      }
      if (aliveRef.current) setInitialized(true);
    })();
  }, [refreshProjects]);

  // while the backend is down, probe for recovery so the app self-heals —
  // including re-running project auto-selection if the initial pick happened
  // while the backend was unreachable (list was empty then)
  useEffect(() => {
    if (!backendDown) return;
    const interval = setInterval(() => {
      void refreshProjects().then((list) => {
        if (list.length === 0) return;
        setProjectName((current) => {
          if (current) return current;
          const saved = localStorage.getItem(STORAGE_KEY) ?? '';
          const pick = list.includes(saved) ? saved : list[0];
          localStorage.setItem(STORAGE_KEY, pick);
          return pick;
        });
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [backendDown, refreshProjects]);

  const refreshState = useCallback(async (): Promise<void> => {
    if (!projectName) return;
    try {
      const res = await fetch(`/api/project/${encodeURIComponent(projectName)}`);
      if (res.status === 404) {
        // stale selection (deleted project / T-38 no-shell fix) — clear it
        localStorage.removeItem(STORAGE_KEY);
        if (aliveRef.current) setProjectName('');
        void refreshProjects();
        return;
      }
      const data = await res.json();
      if (!aliveRef.current) return;
      setBackendDown(false);
      if (data.project) setProject(data.project);
      if (Array.isArray(data.shots)) setShots(data.shots);
      if (Array.isArray(data.elements)) setElements(data.elements);
    } catch (e) {
      // TypeError = network failure (backend down); other errors transient
      if (e instanceof TypeError && aliveRef.current) setBackendDown(true);
    }
  }, [projectName, refreshProjects]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  // one WS per selected project
  useEffect(() => {
    if (!projectName) {
      setWsConnected(false);
      return;
    }
    const ws = new WebSocket(`ws://${window.location.host}/ws/?project=${encodeURIComponent(projectName)}`);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (event) => {
      let msg: ProjectWsMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'sync' && Array.isArray(msg.shots)) {
        setShots(msg.shots as Shot[]);
      } else if (msg.type === 'shotEvent' && typeof msg.shotId === 'string') {
        setShots((prev) => prev.map((s) => (s.id === msg.shotId ? { ...s, state: msg.state as Shot['state'] } : s)));
      }
      for (const fn of subscribers.current) fn(msg);
    };
    return () => {
      setWsConnected(false);
      ws.close();
    };
  }, [projectName]);

  const subscribe = useCallback((fn: (msg: ProjectWsMessage) => void) => {
    subscribers.current.add(fn);
    return () => {
      subscribers.current.delete(fn);
    };
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      refreshProjects,
      projectName,
      selectProject,
      project,
      shots,
      elements,
      wsConnected,
      refreshState,
      subscribe,
      initialized,
      backendDown,
    }),
    [projects, refreshProjects, projectName, selectProject, project, shots, elements, wsConnected, refreshState, subscribe, initialized, backendDown],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
