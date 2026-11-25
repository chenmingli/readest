import { describe, expect, test, vi } from 'vitest';
import { P115Client } from '@/services/sync/providers/p115/client';
import { FileSyncError } from '@/services/sync/file/provider';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));

const COOKIE = 'UID=u; CID=c; SEID=s; KID=k';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const makeClient = (fetchFn: ReturnType<typeof vi.fn>) =>
  new P115Client(COOKIE, { fetch: fetchFn as unknown as typeof fetch, sleep: async () => {} });

describe('P115Client', () => {
  test('retries a transient 5xx response', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ state: 1, data: [], count: 0 }));
    const client = makeClient(fetchFn);

    await expect(client.listDir('0')).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('does not retry mkdir, which is not idempotent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({}, 500));
    const client = makeClient(fetchFn);

    await expect(client.mkdir('0', 'Readest')).rejects.toBeInstanceOf(FileSyncError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('maps the 990001 errno to an expired login', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ state: false, errno: 990001 }));
    const client = makeClient(fetchFn);

    await expect(client.listDir('0')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: expect.stringContaining('login expired'),
    });
  });

  test('posts the exact OSS form fields the sample upload returns', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          host: 'https://oss.example.com',
          object: 'obj',
          accessid: 'ak',
          policy: 'pol',
          signature: 'sig',
          callback: 'cb',
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const client = makeClient(fetchFn);
    await client.upload('11', 'a.txt', new TextEncoder().encode('hi').buffer as ArrayBuffer);

    const form = fetchFn.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get('name')).toBe('a.txt');
    expect(form.get('key')).toBe('obj');
    expect(form.get('OSSAccessKeyId')).toBe('ak');
    expect(form.get('signature')).toBe('sig');
    expect(form.get('success_action_status')).toBe('200');
    expect(form.get('file')).toBeTruthy();
  });
});
