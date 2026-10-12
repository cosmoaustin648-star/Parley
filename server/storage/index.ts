/**
 * File storage. The default driver writes to local disk (STORAGE_DIR); files
 * are never served directly from disk paths — every read goes through an
 * access-checked route. To use S3-compatible object storage, implement the
 * `StorageDriver` interface (see docs/DEPLOYMENT.md).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from '../config.ts';
import { HttpError } from '../http/router.ts';

export interface StoredFile { key: string; size: number; contentType: string; width?: number; height?: number }

export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  stream(key: string): NodeJS.ReadableStream;
  stat(key: string): Promise<{ size: number } | null>;
  remove(key: string): Promise<void>;
}

class DiskDriver implements StorageDriver {
  constructor(private root: string) { fs.mkdirSync(root, { recursive: true }); }
  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data, { mode: 0o600 });
  }
  stream(key: string) { return fs.createReadStream(this.resolve(key)); }
  async stat(key: string) { try { const s = await fsp.stat(this.resolve(key)); return { size: s.size }; } catch { return null; } }
  async remove(key: string) { await fsp.rm(this.resolve(key), { force: true }); }
}

export const storage: StorageDriver = new DiskDriver(config.storage.dir);

/* ---------------- content sniffing ---------------- */

const SIGNATURES: Array<{ type: string; test: (b: Buffer) => boolean }> = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 4).toString('ascii') === 'GIF8' },
  { type: 'image/webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { type: 'video/webm', test: (b) => b.readUInt32BE(0) === 0x1a45dfa3 },
  { type: 'video/mp4', test: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' },
  { type: 'audio/mpeg', test: (b) => b.subarray(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { type: 'audio/ogg', test: (b) => b.subarray(0, 4).toString('ascii') === 'OggS' },
  { type: 'audio/wav', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE' },
  { type: 'application/pdf', test: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
  { type: 'application/zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
];

export const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/pdf',
]);
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function sniffType(b: Buffer, declared?: string): string {
  if (b.length >= 12) for (const s of SIGNATURES) if (s.test(b)) return s.type;
  // Never trust a declared active type (HTML/SVG/JS); everything else is served as a download.
  const looksText = b.length > 0 && !b.subarray(0, 512).includes(0);
  if (looksText && declared && /^(text\/(plain|csv|markdown)|application\/json)$/.test(declared)) return declared;
  return looksText ? 'text/plain' : 'application/octet-stream';
}

export function imageSize(b: Buffer, type: string): { width: number; height: number } | undefined {
  try {
    if (type === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (type === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (type === 'image/webp') {
      const fmt = b.subarray(12, 16).toString('ascii');
      if (fmt === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* truncated */ }
  return undefined;
}

/** Read a raw upload body (the client sends the file bytes directly, not multipart). */
export async function receiveUpload(req: IncomingMessage, prefix: string, maxBytes = config.storage.maxUploadBytes, onlyImages = false): Promise<StoredFile> {
  const declared = Number(req.headers['content-length'] || 0);
  if (!declared) throw new HttpError(411, 'length_required', 'Upload must include Content-Length.');
  if (declared > maxBytes) throw new HttpError(413, 'payload_too_large', `File is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large', `File is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    chunks.push(c as Buffer);
  }
  if (!size) throw new HttpError(400, 'empty_file', 'The file is empty.');
  const data = Buffer.concat(chunks);
  const contentType = sniffType(data, String(req.headers['content-type'] || ''));
  if (onlyImages && !IMAGE_TYPES.has(contentType)) throw new HttpError(415, 'unsupported_type', 'Please upload a PNG, JPEG, GIF or WebP image.');
  const dims = IMAGE_TYPES.has(contentType) ? imageSize(data, contentType) : undefined;
  const now = new Date();
  const key = `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomBytes(16).toString('hex')}`;
  await storage.put(key, data);
  return { key, size, contentType, width: dims?.width, height: dims?.height };
}

export function safeFilename(name: string) {
  const cleaned = name.normalize('NFKC').replace(/[\\/\x00-\x1f\x7f"<>|:*?]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'file';
}
