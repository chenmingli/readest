import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  Open115Client,
  finishOpenDeviceLogin,
  pollOpenDeviceLogin,
  startOpenDeviceLogin,
} from '@/services/sync/providers/p115/openClient';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const makeClient = (fetchFn: ReturnType<typeof vi.fn>, overrides = {}) =>
  new Open115Client({
    clientId: 'cid',
    accessToken: 'a1',
    refreshToken: 'r1',
    accessTokenExpiresAt: Date.now() + 3_600_000,
    fetch: fetchFn as unknown as typeof fetch,
    sleep: async () => {},
    ...overrides,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('115 Open Platform device flow', () => {
  test('sends a PKCE challenge and exchanges the approved code', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          code: 0,
          data: {
            uid: 'u1',
            time: 123,
            qrcode: 'https://115.com/scan/dg-u1',
            sign: 'sig',
          },
        }),
      )
      .mockResolvedValueOnce(json({ code: 0, data: { status: 2 } }))
      .mockResolvedValueOnce(
        json({
          code: 0,
          data: { access_token: 'at', refresh_token: 'rt', expires_in: 7200 },
        }),
      );

    const { device, verifier } = await startOpenDeviceLogin(
      'cid',
      fetchFn as unknown as typeof fetch,
    );
    expect(device.uid).toBe('u1');
    expect(device.qrcode).toContain('scan');

    const form = new URLSearchParams((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('code_challenge_method')).toBe('sha256');
    expect(form.get('code_challenge')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(form.get('code_challenge')).toHaveLength(44);

    await expect(pollOpenDeviceLogin(device, fetchFn as unknown as typeof fetch)).resolves.toBe(2);
    await expect(
      finishOpenDeviceLogin(device, verifier, fetchFn as unknown as typeof fetch),
    ).resolves.toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 7200 });
  });
});

describe('Open115Client', () => {
  test('rotates an expired access token before the request', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          code: 0,
          data: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 },
        }),
      )
      .mockResolvedValueOnce(
        json({
          state: true,
          code: 0,
          data: [{ fid: '10', fc: '0', fn: 'Readest', pc: '', fs: 0 }],
        }),
      );
    const onTokens = vi.fn();
    const client = makeClient(fetchFn, { accessTokenExpiresAt: Date.now() - 1000, onTokens });

    const entries = await client.listDir('0');
    expect(entries).toEqual([
      {
        name: 'Readest',
        cid: '10',
        fid: undefined,
        pickCode: undefined,
        size: 0,
        isDirectory: true,
      },
    ]);
    expect(onTokens).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'a2', refreshToken: 'r2' }),
    );
    const auth = (fetchFn.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(auth['Authorization']).toBe('Bearer a2');
  });

  test('refreshes once and retries when 115 rejects the token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ state: false, code: 401001, message: 'token expired' }))
      .mockResolvedValueOnce(
        json({
          code: 0,
          data: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 },
        }),
      )
      .mockResolvedValueOnce(json({ state: true, code: 0, data: [] }));
    const client = makeClient(fetchFn);

    await expect(client.listDir('0')).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const retryAuth = (fetchFn.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>;
    expect(retryAuth['Authorization']).toBe('Bearer a2');
  });

  test('maps folders and files from the open file list', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      json({
        state: true,
        code: 0,
        data: [
          { fid: '1', fc: '0', fn: 'books' },
          { fid: '2', fc: '1', fn: 'library.json', pc: 'p1', fs: 42 },
        ],
      }),
    );
    const client = makeClient(fetchFn);

    await expect(client.listDir('0')).resolves.toEqual([
      {
        name: 'books',
        cid: '1',
        fid: undefined,
        pickCode: undefined,
        size: undefined,
        isDirectory: true,
      },
      {
        name: 'library.json',
        cid: undefined,
        fid: '2',
        pickCode: 'p1',
        size: 42,
        isDirectory: false,
      },
    ]);
  });

  test('puts the file on OSS with the signed callback headers', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          state: true,
          code: 0,
          data: {
            status: 1,
            bucket: 'fhnfile',
            object: 'obj/key.bin',
            callback: { callback: '{"callbackUrl":"x"}', callback_var: '{"a":"b"}' },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          state: true,
          code: 0,
          data: {
            endpoint: 'oss-cn-shenzhen.aliyuncs.com',
            AccessKeyId: 'ak',
            AccessKeySecret: 'sk',
            SecurityToken: 'st',
            expiration: 'soon',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const client = makeClient(fetchFn);
    const body = new TextEncoder().encode('hello').buffer as ArrayBuffer;

    await client.upload('0', 'hello.txt', body);
    const [url, init] = fetchFn.mock.calls[2] as [string, RequestInit];
    expect(url).toBe('https://fhnfile.oss-cn-shenzhen.aliyuncs.com/obj/key.bin');
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-oss-callback']).toBe(btoa('{"callbackUrl":"x"}'));
    expect(headers['x-oss-security-token']).toBe('st');
    expect(headers['Authorization']).toMatch(/^OSS ak:/);
  });

  test('proves the requested byte range when 115 asks for a second pass', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({ state: true, code: 0, data: { status: 7, sign_key: 'k', sign_check: '0-3' } }),
      )
      .mockResolvedValueOnce(json({ state: true, code: 0, data: { status: 2 } }));
    const client = makeClient(fetchFn);
    const body = new TextEncoder().encode('abcd').buffer as ArrayBuffer;

    await client.upload('0', 'x.bin', body);
    const form = new URLSearchParams((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(form.get('sign_key')).toBe('k');
    expect(form.get('sign_val')).toBe('81FE8BFE87576C3ECB22426F8E57847382917ACF');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
