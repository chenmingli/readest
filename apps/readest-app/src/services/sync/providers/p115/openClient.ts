/**
 * 115 Open Platform client (OAuth device flow + OpenAPI).
 *
 * The web-API client in `client.ts` relies on a browser session cookie that
 * 115 silently expires and cannot be renewed from a native app. The Open
 * Platform issues a long-lived refresh token instead: the user approves a
 * device code once, and afterwards every access token is renewed in place.
 *
 * Only the operations the file-sync engine needs are implemented: list, mkdir,
 * delete, download URL and upload. Uploads follow the official flow: SHA-1
 * init (with the range proof when 115 asks for it) and a signed Aliyun OSS PUT
 * carrying 115's callback headers.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { FileSyncError, FileSyncErrorCode } from '@/services/sync/file/provider';
import type { P115Entry } from './client';

const PASSPORT_BASE = 'https://passportapi.115.com';
const QRCODE_STATUS_URL = 'https://qrcodeapi.115.com/get/status/';
const PROAPI_BASE = 'https://proapi.115.com';
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_MARGIN_MS = 120_000;
const MAX_ATTEMPTS = 3;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const PREID_SIZE = 128 * 1024;

type Json = Record<string, unknown>;

const isTauri = (): boolean => isTauriAppPlatform();

const nativeFetch: typeof fetch = isTauri()
  ? (tauriFetch as unknown as typeof fetch)
  : (...args: Parameters<typeof fetch>) => fetch(...args);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const base64Url = (bytes: Uint8Array): string =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sha1Hex = (bytes: Uint8Array): string => bytesToHex(sha1(bytes)).toUpperCase();

const codeForStatus = (status: number): FileSyncErrorCode => {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status >= 500) return 'NETWORK';
  return 'UNKNOWN';
};

const AUTH_CODES = new Set([99, 401, 990001]);

/** 115 returns `state: false` with a business code for almost every failure. */
const isAuthCode = (code: number): boolean =>
  AUTH_CODES.has(code) || (code >= 401000 && code < 402000);

const errorFrom = (message: string, code: FileSyncErrorCode, status?: number): FileSyncError =>
  new FileSyncError(message, code, status);

export interface OpenDeviceCode {
  uid: string;
  time: number;
  sign: string;
  /** Content to encode in the QR code (115 renders the approval page). */
  qrcode: string;
}

export interface OpenTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** Absolute expiry, persisted so a restart does not trust a stale token. */
  expiresAt?: number;
}

export type OpenQrStatus = 0 | 1 | 2 | -1 | -2;

const authData = async <T>(response: Response, what: string): Promise<T> => {
  const body = (await response.json().catch(() => null)) as
    | (Json & { data?: T; code?: number; message?: string; error?: string; errno?: number })
    | null;
  if (!body) throw errorFrom(`115 ${what} returned an unreadable response`, 'NETWORK');
  const success = body.code === 0 || body.code === undefined || body.code === 1;
  if (response.ok && success && body.data) return body.data;
  const message = String(body.message || body.error || `115 ${what} failed`);
  throw errorFrom(message, 'AUTH_FAILED', response.status);
};

const formBody = (form: Record<string, string>): URLSearchParams => new URLSearchParams(form);

const postForm = (
  url: string,
  form: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<Response> =>
  fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(form),
  });

/**
 * Start the PKCE device flow. The verifier never leaves the app; only its
 * SHA-256 challenge is sent to 115.
 */
export const startOpenDeviceLogin = async (
  clientId: string,
  fetchFn: typeof fetch = nativeFetch,
): Promise<{ device: OpenDeviceCode; verifier: string }> => {
  if (!clientId.trim()) throw errorFrom('115 Open Platform client id is required', 'AUTH_FAILED');
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64Url(random);
  const challenge = base64(sha256(utf8ToBytes(verifier)));
  const response = await postForm(
    `${PASSPORT_BASE}/open/authDeviceCode`,
    { client_id: clientId.trim(), code_challenge: challenge, code_challenge_method: 'sha256' },
    fetchFn,
  );
  const data = await authData<{ uid: string; time: number; qrcode: string; sign: string }>(
    response,
    'device authorization',
  );
  return { device: { ...data, time: Number(data.time) }, verifier };
};

export const pollOpenDeviceLogin = async (
  device: OpenDeviceCode,
  fetchFn: typeof fetch = nativeFetch,
): Promise<OpenQrStatus> => {
  const url = new URL(QRCODE_STATUS_URL);
  url.searchParams.set('uid', device.uid);
  url.searchParams.set('time', String(device.time));
  url.searchParams.set('sign', device.sign);
  const response = await fetchFn(url.toString());
  const data = await authData<{ status?: number }>(response, 'device status');
  const status = Number(data.status ?? 0);
  return ([0, 1, 2, -1, -2].includes(status) ? status : 0) as OpenQrStatus;
};

export const finishOpenDeviceLogin = async (
  device: OpenDeviceCode,
  verifier: string,
  fetchFn: typeof fetch = nativeFetch,
): Promise<OpenTokens> => {
  const response = await postForm(
    `${PASSPORT_BASE}/open/deviceCodeToToken`,
    { uid: device.uid, code_verifier: verifier },
    fetchFn,
  );
  const data = await authData<{ access_token: string; refresh_token: string; expires_in: number }>(
    response,
    'device token exchange',
  );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) || 0,
  };
};

/**
 * Refresh tokens are rotated on every use; losing the newest one would force
 * a fresh QR scan, so the rotated pair is mirrored into localStorage in
 * addition to the settings slice.
 */
const vaultKey = (clientId: string): string => `readest:p115:open:${clientId}`;

export const loadOpenTokens = (clientId: string): OpenTokens | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(vaultKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenTokens>;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresIn: Number(parsed.expiresIn) || 0,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
    };
  } catch {
    return null;
  }
};

export const saveOpenTokens = (clientId: string, tokens: OpenTokens): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(vaultKey(clientId), JSON.stringify(tokens));
  } catch {
    // Storage may be unavailable (private mode); settings still keep a copy.
  }
};

export const clearOpenTokens = (clientId: string): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(vaultKey(clientId));
  } catch {
    // Ignore storage failures.
  }
};

export interface Open115ClientOptions {
  clientId: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Called whenever 115 rotates the pair, so the settings slice stays fresh. */
  onTokens?: (tokens: OpenTokens) => void;
}

interface UploadInit {
  pick_code?: string;
  status: number;
  sign_key?: string;
  sign_check?: string;
  bucket?: string;
  object?: string;
  callback?:
    | { callback?: string; callback_var?: string }
    | Array<{ callback?: string; callback_var?: string }>;
}

interface UploadToken {
  endpoint: string;
  AccessKeyId: string;
  AccessKeySecret: string;
  SecurityToken: string;
}

export class Open115Client {
  readonly kind = 'open' as const;

  private readonly clientId: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly onTokens?: (tokens: OpenTokens) => void;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;
  private refreshing?: Promise<void>;

  constructor(options: Open115ClientOptions) {
    this.clientId = options.clientId.trim();
    this.fetchFn = options.fetch ?? nativeFetch;
    this.sleepFn = options.sleep ?? sleep;
    this.onTokens = options.onTokens;
    const saved = loadOpenTokens(this.clientId);
    this.accessToken = saved?.accessToken ?? options.accessToken ?? '';
    this.refreshToken = saved?.refreshToken ?? options.refreshToken ?? '';
    this.expiresAt =
      options.accessTokenExpiresAt ??
      saved?.expiresAt ??
      (saved ? Date.now() + Math.max(0, saved.expiresIn) * 1000 : 0);
  }

  private store(tokens: OpenTokens): void {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.expiresAt = tokens.expiresAt ?? Date.now() + Math.max(0, tokens.expiresIn) * 1000;
    saveOpenTokens(this.clientId, { ...tokens, expiresAt: this.expiresAt });
    this.onTokens?.(tokens);
  }

  private async doRefresh(): Promise<void> {
    if (!this.refreshToken) {
      throw errorFrom('115 session expired, sign in again', 'AUTH_FAILED');
    }
    const response = await this.fetchWithTimeout(`${PASSPORT_BASE}/open/refreshToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ refresh_token: this.refreshToken }),
    });
    if (!response.ok) {
      throw errorFrom('115 session expired, sign in again', 'AUTH_FAILED', response.status);
    }
    const data = await authData<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>(response, 'token refresh');
    this.store({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: Number(data.expires_in) || 0,
    });
  }

  private refreshAccessToken(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async ensureAccessToken(force = false): Promise<string> {
    const fresh = this.accessToken && this.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS;
    if (!force && fresh) return this.accessToken;
    await this.refreshAccessToken();
    return this.accessToken;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    if (!isTauri()) {
      throw errorFrom('115 Netdisk sync requires the desktop app', 'AUTH_FAILED');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw errorFrom(message, 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      query?: Record<string, string>;
      form?: Record<string, string>;
      retryAuth?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(`${PROAPI_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.ensureAccessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      let body: URLSearchParams | undefined;
      if (options.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = formBody(options.form);
      }
      const response = await this.fetchWithTimeout(url.toString(), {
        method: options.method ?? 'GET',
        headers,
        body,
      });
      const payload = (await response.json().catch(() => null)) as
        | (Json & { state?: boolean; code?: number; message?: string; data?: T })
        | null;
      if (!payload) {
        if (attempt < MAX_ATTEMPTS && response.status >= 500) {
          await this.sleepFn(250 * attempt);
          continue;
        }
        throw errorFrom('115 returned an unreadable response', 'NETWORK', response.status);
      }
      if (payload.state !== false) return payload.data as T;
      const code = Number(payload.code ?? 0);
      if (isAuthCode(code) && options.retryAuth !== false) {
        await this.refreshAccessToken();
        return this.request<T>(path, { ...options, retryAuth: false });
      }
      if (isAuthCode(code)) throw errorFrom('115 session expired, sign in again', 'AUTH_FAILED');
      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        await this.sleepFn(250 * attempt);
        continue;
      }
      throw errorFrom(
        String(payload.message || '115 request failed'),
        codeForStatus(response.status),
      );
    }
  }

  async listDir(cid: string): Promise<P115Entry[]> {
    const entries: P115Entry[] = [];
    for (let offset = 0; ; offset += 1000) {
      const data = await this.request<
        Array<{
          fid?: string;
          fc?: string | number;
          fn?: string;
          pc?: string;
          fs?: number;
        }>
      >('/open/ufile/files', {
        query: {
          cid,
          limit: '1000',
          offset: String(offset),
          show_dir: '1',
          stdir: '1',
          cur: '1',
        },
      });
      const page = Array.isArray(data) ? data : [];
      for (const item of page) {
        const isDirectory = String(item.fc) === '0';
        const id = String(item.fid ?? '');
        entries.push({
          name: String(item.fn ?? ''),
          cid: isDirectory ? id : undefined,
          fid: isDirectory ? undefined : id,
          pickCode: item.pc ? String(item.pc) : undefined,
          size: typeof item.fs === 'number' ? item.fs : undefined,
          isDirectory,
        });
      }
      if (page.length < 1000) break;
    }
    return entries;
  }

  async mkdir(parentId: string, name: string): Promise<string> {
    const data = await this.request<{ file_id?: string }>('/open/folder/add', {
      method: 'POST',
      form: { pid: parentId, file_name: name },
    });
    if (!data?.file_id) throw errorFrom('115 did not return the created folder id', 'UNKNOWN');
    return String(data.file_id);
  }

  async delete(id: string, parentId = '0'): Promise<void> {
    await this.request('/open/ufile/delete', {
      method: 'POST',
      form: { file_ids: id, parent_id: parentId },
    });
  }

  async downloadUrl(pickCode: string): Promise<{ url: string; cookies?: string[] }> {
    const data = await this.request<Record<string, { url?: { url?: string } }>>(
      '/open/ufile/downurl',
      { method: 'POST', form: { pick_code: pickCode } },
    );
    const first = data && typeof data === 'object' ? Object.values(data)[0] : undefined;
    const url = first?.url?.url;
    if (!url) throw errorFrom('115 did not return a download URL', 'NOT_FOUND');
    return { url };
  }

  async download(url: string): Promise<ArrayBuffer> {
    const response = await this.fetchWithTimeout(url, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw errorFrom(`115 download failed (${response.status})`, codeForStatus(response.status));
    }
    return response.arrayBuffer();
  }

  private async initUpload(
    parentId: string,
    name: string,
    size: number,
    fileId: string,
    preId: string,
    proof?: { signKey: string; signVal: string },
  ): Promise<UploadInit> {
    return this.request<UploadInit>('/open/upload/init', {
      method: 'POST',
      form: {
        file_name: name,
        file_size: String(size),
        target: `U_1_${parentId}`,
        fileid: fileId,
        preid: preId,
        topload: '1',
        ...(proof ? { sign_key: proof.signKey, sign_val: proof.signVal } : {}),
      },
    });
  }

  async upload(parentId: string, name: string, body: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(body);
    const fileId = sha1Hex(bytes);
    const preId = sha1Hex(bytes.subarray(0, Math.min(PREID_SIZE, bytes.length)));
    let init = await this.initUpload(parentId, name, bytes.length, fileId, preId);
    if (init.status === 2) return;

    if ([6, 7, 8].includes(init.status)) {
      const parts = String(init.sign_check ?? '').split('-');
      const start = Number(parts[0]);
      const end = Number(parts[1]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw errorFrom('115 asked for an invalid upload proof range', 'UNKNOWN');
      }
      const signVal = sha1Hex(bytes.subarray(start, end + 1));
      init = await this.initUpload(parentId, name, bytes.length, fileId, preId, {
        signKey: String(init.sign_key ?? ''),
        signVal,
      });
      if (init.status === 2) return;
    }

    if (init.status !== 1) {
      throw errorFrom(`115 upload was not accepted (status ${init.status})`, 'UNKNOWN');
    }
    const token = await this.request<UploadToken>('/open/upload/get_token');
    await this.putObject(token, init, bytes);
  }

  private async putObject(token: UploadToken, init: UploadInit, bytes: Uint8Array): Promise<void> {
    if (!init.bucket || !init.object) {
      throw errorFrom('115 did not return an upload target', 'UNKNOWN');
    }
    const callback = Array.isArray(init.callback) ? init.callback[0] : init.callback;
    if (!callback?.callback) {
      throw errorFrom('115 did not return an upload callback', 'UNKNOWN');
    }
    const endpoint = token.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const object = init.object.replace(/^\/+/, '');
    const contentType = 'application/octet-stream';
    const date = new Date().toUTCString();
    const ossHeaders: Record<string, string> = {
      'x-oss-security-token': token.SecurityToken,
      'x-oss-callback': base64(utf8ToBytes(callback.callback)),
      'x-oss-callback-var': base64(utf8ToBytes(callback.callback_var ?? '')),
    };
    const canonicalHeaders = Object.keys(ossHeaders)
      .sort()
      .map((key) => `${key}:${ossHeaders[key]}\n`)
      .join('');
    const resource = `/${init.bucket}/${object}`;
    const stringToSign = `PUT\n\n${contentType}\n${date}\n${canonicalHeaders}${resource}`;
    const signature = base64(
      hmac(sha1, utf8ToBytes(token.AccessKeySecret), utf8ToBytes(stringToSign)),
    );
    const url = `https://${init.bucket}.${endpoint}/${object
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;

    const response = await this.fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        ...ossHeaders,
        Date: date,
        'Content-Type': contentType,
        Authorization: `OSS ${token.AccessKeyId}:${signature}`,
      },
      body: bytes.buffer as ArrayBuffer,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw errorFrom(
        `115 upload failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
        codeForStatus(response.status),
      );
    }
  }
}
