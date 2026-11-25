import { describe, expect, test, vi } from 'vitest';
import type { P115Client } from '@/services/sync/providers/p115/client';
import { P115Provider } from '@/services/sync/providers/p115/P115Provider';
import { FileSyncError } from '@/services/sync/file/provider';
import type { P115Settings } from '@/types/settings';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));

const settings = {
  enabled: true,
  cookie: 'UID=u; CID=c; SEID=s; KID=k',
  rootPath: '/',
} as P115Settings;

const dir = (name: string, cid: string) => ({ name, cid, isDirectory: true });
const file = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  fid: 'f1',
  isDirectory: false,
  ...extra,
});

const makeProvider = (impl: Record<string, ReturnType<typeof vi.fn>>) => {
  const client = {
    kind: 'cookie' as const,
    listDir: vi.fn(async () => []),
    mkdir: vi.fn(async () => '1'),
    delete: vi.fn(async () => {}),
    upload: vi.fn(async () => {}),
    downloadUrl: vi.fn(),
    download: vi.fn(),
    ...impl,
  };
  return {
    provider: new P115Provider(settings, client as unknown as P115Client),
    client,
  };
};

describe('P115Provider', () => {
  test('creates the parent folders and uploads a new file', async () => {
    const listDir = vi.fn(async (cid: string) => {
      if (cid === '0') return [dir('Readest', '10')];
      if (cid === '10') return [dir('books', '11')];
      return [];
    });
    const { provider, client } = makeProvider({ listDir });

    await provider.writeBinary('/Readest/books/library.json', new ArrayBuffer(2));

    expect(client.mkdir).not.toHaveBeenCalled();
    expect(client.upload).toHaveBeenCalledWith('11', 'library.json', expect.any(ArrayBuffer));
  });

  test('replaces an existing file instead of stacking revisions', async () => {
    const listDir = vi.fn(async (cid: string) => {
      if (cid === '0') return [dir('Readest', '10')];
      if (cid === '10') return [file('library.json', { size: 2 })];
      return [];
    });
    const { provider, client } = makeProvider({ listDir });

    await provider.writeBinary('/Readest/library.json', new ArrayBuffer(2));

    expect(client.delete).toHaveBeenCalledWith('f1', '10');
    expect(client.upload).toHaveBeenCalledWith('10', 'library.json', expect.any(ArrayBuffer));
  });

  test('adopts a folder that a raced mkdir created', async () => {
    let calls = 0;
    const listDir = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? [] : [dir('Readest', '10')];
    });
    const mkdir = vi.fn(async () => {
      throw new FileSyncError('already exists', 'CONFLICT');
    });
    const { provider } = makeProvider({ listDir, mkdir });

    await expect(provider.ensureDir(['/Readest'])).resolves.toBeUndefined();
    expect(mkdir).toHaveBeenCalledTimes(1);
  });

  test('shares one folder walk between concurrent callers', async () => {
    const listDir = vi.fn(async (_cid: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [dir('Readest', '10')];
    });
    const { provider } = makeProvider({ listDir });

    await Promise.all([provider.list('/Readest'), provider.list('/Readest')]);

    expect(listDir.mock.calls.filter(([cid]) => cid === '0')).toHaveLength(1);
  });

  test('returns null for a missing file', async () => {
    const { provider } = makeProvider({ listDir: vi.fn(async () => [dir('Readest', '10')]) });
    await expect(provider.readBinary('/Readest/missing.epub')).resolves.toBeNull();
  });

  test('turns a failed large download into an actionable error', async () => {
    const listDir = vi.fn(async (cid: string) =>
      cid === '0'
        ? [dir('Readest', '10')]
        : [file('big.epub', { pickCode: 'pc', size: 300 * 1024 * 1024 })],
    );
    const downloadUrl = vi.fn(async () => {
      throw new FileSyncError('115 did not return a download URL', 'AUTH_FAILED');
    });
    const { provider } = makeProvider({ listDir, downloadUrl });

    await expect(provider.readBinary('/Readest/big.epub')).rejects.toThrow(/200 MB/);
  });
});
