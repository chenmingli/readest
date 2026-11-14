/**
 * 115 Netdisk implementation of {@link FileSyncProvider}.
 *
 * The backend is path-addressed from the engine's point of view; 115 is
 * folder-id-addressed, so this layer resolves each path segment to a `cid`
 * (listing one level, then creating the folder when asked) and memoises the
 * mapping for the provider's lifetime. A stale cached id self-heals: any
 * request that 115 rejects with a missing folder is dropped from the cache.
 */
import type { P115Settings } from '@/types/settings';
import {
  FileEntry,
  FileHead,
  FileSyncError,
  FileSyncProvider,
} from '@/services/sync/file/provider';
import { P115Client, P115Entry } from './client';

const normalizeRootPath = (path: string): string => {
  const trimmed = (path || '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '/';
};

const joinPath = (dir: string, name: string): string =>
  dir === '/' ? `/${name}` : `${dir}/${name}`;

export const createP115Provider = (settings: P115Settings): FileSyncProvider | null => {
  if (!settings.cookie) return null;
  return new P115Provider(settings);
};

class P115Provider implements FileSyncProvider {
  readonly rootPath: string;
  private readonly client: P115Client;
  private readonly dirIds = new Map<string, string>();
  private readonly entryCache = new Map<string, { at: number; entries: P115Entry[] }>();

  constructor(settings: P115Settings) {
    this.rootPath = normalizeRootPath(settings.rootPath);
    this.client = new P115Client(settings.cookie ?? '');
  }

  private segments(path: string): string[] {
    return path.split('/').filter(Boolean);
  }

  private async listCached(cid: string): Promise<P115Entry[]> {
    const cached = this.entryCache.get(cid);
    if (cached && Date.now() - cached.at < 2000) return cached.entries;
    const entries = await this.client.listDir(cid);
    this.entryCache.set(cid, { at: Date.now(), entries });
    return entries;
  }

  /** Walk `path` from the drive root, optionally creating missing folders. */
  private async resolveDir(path: string, create: boolean): Promise<string | null> {
    let cid = '0';
    let current = '';
    for (const segment of this.segments(path)) {
      current = joinPath(current, segment);
      const cached = this.dirIds.get(current);
      if (cached) {
        cid = cached;
        continue;
      }
      const entries = await this.listCached(cid);
      const found = entries.find((entry) => entry.name === segment && entry.isDirectory);
      if (found?.cid) {
        cid = found.cid;
        this.dirIds.set(current, cid);
        continue;
      }
      if (!create) return null;
      cid = await this.client.mkdir(cid, segment);
      this.dirIds.set(current, cid);
      this.entryCache.delete(cid);
    }
    return cid;
  }

  private async findEntry(path: string): Promise<{ cid: string; entry: P115Entry } | null> {
    const slash = path.lastIndexOf('/');
    const parentPath = slash <= 0 ? '/' : path.slice(0, slash);
    const name = path.slice(slash + 1);
    const parentId = await this.resolveDir(parentPath, false);
    if (!parentId) return null;
    const entries = await this.listCached(parentId);
    const entry = entries.find((item) => item.name === name);
    return entry ? { cid: parentId, entry } : null;
  }

  private wrap(error: unknown): never {
    if (error instanceof FileSyncError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new FileSyncError(message, 'UNKNOWN');
  }

  async readText(path: string): Promise<string | null> {
    const binary = await this.readBinary(path);
    return binary ? new TextDecoder().decode(binary) : null;
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    try {
      const found = await this.findEntry(path);
      if (!found || found.entry.isDirectory) return null;
      if (!found.entry.pickCode) return null;
      const target = await this.client.downloadUrl(found.entry.pickCode);
      return await this.client.download(target.url, target.cookies);
    } catch (error) {
      this.wrap(error);
    }
  }

  async head(path: string): Promise<FileHead | null> {
    try {
      const found = await this.findEntry(path);
      if (!found) return null;
      const { entry } = found;
      return { size: entry.size, etag: entry.fid ?? entry.cid };
    } catch (error) {
      this.wrap(error);
    }
  }

  async list(path: string): Promise<FileEntry[]> {
    try {
      const cid = await this.resolveDir(normalizeRootPath(path), false);
      if (!cid) return [];
      const entries = await this.listCached(cid);
      return entries.map((entry) => ({
        name: entry.name,
        path: joinPath(normalizeRootPath(path), entry.name),
        isDirectory: entry.isDirectory,
        size: entry.size,
      }));
    } catch (error) {
      this.wrap(error);
    }
  }

  async writeText(path: string, body: string): Promise<void> {
    await this.writeBinary(path, new TextEncoder().encode(body).buffer as ArrayBuffer);
  }

  async writeBinary(path: string, body: ArrayBuffer): Promise<void> {
    try {
      const slash = path.lastIndexOf('/');
      const parentPath = slash <= 0 ? '/' : path.slice(0, slash);
      const name = path.slice(slash + 1);
      const parentId = await this.resolveDir(parentPath, true);
      if (!parentId) throw new FileSyncError('115 upload folder is unavailable', 'NETWORK');

      // 115 stores duplicate names; delete the previous copy first so a sync
      // updates library.json in place instead of piling up revisions.
      const entries = await this.listCached(parentId);
      const existing = entries.find((entry) => entry.name === name && !entry.isDirectory);
      if (existing?.fid) {
        await this.client.delete(existing.fid);
        this.entryCache.delete(parentId);
      }
      await this.client.upload(parentId, name, body);
      this.entryCache.delete(parentId);
    } catch (error) {
      this.wrap(error);
    }
  }

  async ensureDir(paths: string[]): Promise<void> {
    try {
      for (const path of [...paths].sort((a, b) => a.length - b.length)) {
        await this.resolveDir(normalizeRootPath(path), true);
      }
    } catch (error) {
      this.wrap(error);
    }
  }

  async deleteDir(path: string): Promise<void> {
    try {
      const normalized = normalizeRootPath(path);
      const cid = await this.resolveDir(normalized, false);
      if (!cid) return;
      await this.client.delete(cid);
      for (const key of [...this.dirIds.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) this.dirIds.delete(key);
      }
      this.entryCache.clear();
    } catch (error) {
      this.wrap(error);
    }
  }
}
