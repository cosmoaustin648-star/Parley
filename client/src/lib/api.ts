export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...init,
    });
  } catch {
    throw new ApiError(0, 'network', "Can't reach Parley. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code || 'error', e?.message || `Request failed (${res.status}).`, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => request<T>('GET', u),
  post: <T = any>(u: string, b: unknown = {}) => request<T>('POST', u, b),
  patch: <T = any>(u: string, b: unknown = {}) => request<T>('PATCH', u, b),
  put: <T = any>(u: string, b: unknown = {}) => request<T>('PUT', u, b),
  del: <T = any>(u: string, b?: unknown) => request<T>('DELETE', u, b),
};

/** Raw-body upload with progress (XHR gives upload progress events; fetch doesn't). */
export function upload<T = any>(method: string, url: string, file: Blob, opts: { filename?: string; onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (opts.filename) xhr.setRequestHeader('X-Filename', encodeURIComponent(opts.filename));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || 'error', data?.error?.message || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Upload failed. Check your connection.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    opts.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
