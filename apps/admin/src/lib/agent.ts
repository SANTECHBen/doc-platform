// Onboarding-agent admin client.
//
// Wraps the /admin/agent/* endpoints, walks a local folder via the File
// System Access API, routes uploads (videos → Mux Direct Upload, others →
// /admin/agent/runs/:id/upload), and exposes a typed SSE consumer.

const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_BASE) ||
  'http://localhost:3001';

async function authHeaders(): Promise<Record<string, string>> {
  if (typeof window === 'undefined') return {};
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store' });
    if (res.ok) {
      const session = (await res.json()) as { idToken?: string } | null;
      if (session?.idToken) {
        return { authorization: `Bearer ${session.idToken}` };
      }
    }
  } catch {
    // fall through unauthenticated
  }
  return {};
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  relativePath: string;
  size: number;
  contentType: string | null;
  lastModified: number | null;
}
export interface Manifest {
  rootName: string;
  totalFiles: number;
  totalBytes: number;
  entries: ManifestEntry[];
}

// Carries the live File handle so the uploader can read each file once
// the user clicks Upload — without holding all bytes in memory at scan time.
export interface ScannedFile {
  relativePath: string;
  size: number;
  contentType: string | null;
  lastModified: number | null;
  file: File;
}

export interface AgentRunSummary {
  id: string;
  status:
    | 'scanning'
    | 'uploading'
    | 'proposing'
    | 'awaiting_review'
    | 'executing'
    | 'completed'
    | 'failed'
    | 'cancelled';
  manifestRoot: string | null;
  manifestFiles: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunDetail {
  run: {
    id: string;
    status: AgentRunSummary['status'];
    manifest: Manifest | null;
    error: string | null;
    targetOrganizationId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  files: Array<{
    id: string;
    relativePath: string;
    size: number;
    contentType: string | null;
    status: 'pending' | 'uploaded' | 'mux_processing' | 'ready' | 'failed';
    storageKey: string | null;
    muxUploadId: string | null;
    muxAssetId: string | null;
    streamPlaybackId: string | null;
  }>;
  proposal: {
    id: string;
    version: number;
    content: unknown;
    summary: string | null;
    modelUsed: string | null;
    tokenUsage: { inputTokens: number; outputTokens: number } | null;
    updatedAt: string;
  } | null;
}

// ---------------------------------------------------------------------------
// File System Access API folder walker
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.next',
  '.DS_Store',
  '__MACOSX',
  '.idea',
  '.vscode',
]);

const SKIP_FILE_PREFIXES = ['~$', '.~lock.', '.DS_Store', 'Thumbs.db'];

export async function pickAndScanFolder(): Promise<{ rootName: string; files: ScannedFile[] } | null> {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    throw new Error(
      'Your browser does not support the File System Access API. Use a Chromium-based browser (Chrome, Edge, Arc).',
    );
  }
  const handle = await window.showDirectoryPicker({ mode: 'read' });
  const files: ScannedFile[] = [];
  await walkDirectory(handle, '', files);
  return { rootName: handle.name, files };
}

async function walkDirectory(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: ScannedFile[],
): Promise<void> {
  // entries() is async-iterable in supporting browsers.
  // @ts-expect-error — DOM types may not include entries()
  for await (const [name, entry] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(name)) continue;
      await walkDirectory(
        entry as FileSystemDirectoryHandle,
        prefix ? `${prefix}/${name}` : name,
        out,
      );
    } else if (entry.kind === 'file') {
      if (SKIP_FILE_PREFIXES.some((p) => name.startsWith(p))) continue;
      const file = await (entry as FileSystemFileHandle).getFile();
      out.push({
        relativePath: prefix ? `${prefix}/${name}` : name,
        size: file.size,
        contentType: file.type || null,
        lastModified: file.lastModified ?? null,
        file,
      });
    }
  }
}

export function buildManifest(rootName: string, files: ScannedFile[]): Manifest {
  return {
    rootName,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    entries: files.map((f) => ({
      relativePath: f.relativePath,
      size: f.size,
      contentType: f.contentType,
      lastModified: f.lastModified,
    })),
  };
}

// ---------------------------------------------------------------------------
// Agent API wrappers
// ---------------------------------------------------------------------------

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(await authHeaders()),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function createAgentRun(manifest: Manifest): Promise<{ runId: string; status: string }> {
  return api('/admin/agent/runs', {
    method: 'POST',
    body: JSON.stringify({ manifest }),
  });
}

export async function listAgentRuns(): Promise<AgentRunSummary[]> {
  return api('/admin/agent/runs');
}

export async function getAgentRun(runId: string): Promise<AgentRunDetail> {
  return api(`/admin/agent/runs/${encodeURIComponent(runId)}`);
}

export async function patchProposal(
  proposalId: string,
  body: { version: number; content: unknown },
): Promise<{ id: string; version: number; updatedAt: string }> {
  return api(`/admin/agent/proposals/${encodeURIComponent(proposalId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function startProposePhase(
  runId: string,
): Promise<{ runId: string; streamToken: string }> {
  return api(`/admin/agent/runs/${encodeURIComponent(runId)}/propose`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function startExecutePhase(
  proposalId: string,
): Promise<{ executionId: string; runId: string; streamToken: string }> {
  return api(`/admin/agent/proposals/${encodeURIComponent(proposalId)}/execute`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function uploadAgentFile(
  runId: string,
  scanned: ScannedFile,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ runFileId: string; storageKey: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/admin/agent/runs/${encodeURIComponent(runId)}/upload`, true);
    void authHeaders().then((h) => {
      for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`${xhr.status}: ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      const form = new FormData();
      form.append('file', scanned.file, scanned.relativePath.split('/').pop() ?? 'file');
      form.append('relativePath', scanned.relativePath);
      xhr.send(form);
    });
  });
}

export interface MuxUploadInit {
  runFileId: string;
  uploadId: string;
  uploadUrl: string;
}

export async function initMuxUpload(
  runId: string,
  body: { relativePath: string; size: number; contentType: string },
): Promise<MuxUploadInit> {
  return api(`/admin/agent/runs/${encodeURIComponent(runId)}/mux/upload`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function uploadToMux(
  init: MuxUploadInit,
  scanned: ScannedFile,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  // PUT directly to Mux. CORS allows this from the admin origin.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', init.uploadUrl, true);
    xhr.setRequestHeader('content-type', scanned.contentType ?? 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Mux upload ${xhr.status}: ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('Mux upload network error'));
    xhr.send(scanned.file);
  });
}

// ---------------------------------------------------------------------------
// SSE consumer
// ---------------------------------------------------------------------------

export interface AgentSseEvent {
  type: string;
  data: Record<string, unknown> & { _eventId?: number; _ts?: number };
  id: number | null;
}

export interface AgentSseHandle {
  close: () => void;
}

export function subscribeAgentStream(
  runId: string,
  purpose: 'propose' | 'execute',
  streamToken: string,
  onEvent: (evt: AgentSseEvent) => void,
  onError?: (err: unknown) => void,
): AgentSseHandle {
  const url = `${API_BASE}/admin/agent/runs/${encodeURIComponent(runId)}/${purpose}/stream?token=${encodeURIComponent(streamToken)}`;
  const es = new EventSource(url);
  // Catch-all listener for typed events. EventSource fires named events
  // separately; we attach listeners for known names plus a fallback on
  // 'message' for any unnamed events.
  const handle = (type: string) => (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      onEvent({ type, data, id: e.lastEventId ? Number(e.lastEventId) : null });
    } catch (err) {
      onError?.(err);
    }
  };
  const knownTypes = [
    'open',
    'tool_call',
    'tool_result',
    'node_emitted',
    'finalize',
    'warning',
    'error',
    'status',
    'mux_ready',
    'execution_step',
    'done',
  ];
  for (const t of knownTypes) es.addEventListener(t, handle(t) as EventListener);
  es.onerror = (err) => onError?.(err);
  return { close: () => es.close() };
}
