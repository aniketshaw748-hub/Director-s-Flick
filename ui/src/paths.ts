/**
 * paths.ts — media path/URL helpers (T-41).
 * Shot/EDL paths come from the backend as absolute WINDOWS paths; naive
 * `split('/')` doesn't split them (T-40 finding L8). Always basename via
 * this helper before building a media URL.
 */

export function mediaBasename(p: string | undefined | null): string {
  if (!p) return '';
  return p.split(/[\\/]/).pop() ?? p;
}

export function mediaUrl(project: string, type: 'images' | 'clips', fileOrPath: string): string {
  return `/api/project/${encodeURIComponent(project)}/media/${type}/${encodeURIComponent(mediaBasename(fileOrPath))}`;
}
