/**
 * useProjectSocket — page-scoped subscription to a project's WS stream
 * (sync / shotEvent / alignProgress / exportProgress). Complements App.tsx's
 * app-level socket: pages that need push messages beyond the shots array
 * (e.g. TimelinePage's exportProgress) subscribe here without prop-drilling.
 */
import { useEffect, useRef } from 'react';

export type ProjectWsMessage = { type: string } & Record<string, unknown>;

export function useProjectSocket(project: string, onMessage: (msg: ProjectWsMessage) => void): void {
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    if (!project) return;
    const ws = new WebSocket(`ws://${window.location.host}/ws/?project=${encodeURIComponent(project)}`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && typeof msg.type === 'string') cbRef.current(msg);
      } catch {
        /* non-JSON frame — ignore */
      }
    };
    return () => ws.close();
  }, [project]);
}
