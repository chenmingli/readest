/**
 * Minimal 115 Netdisk (115 网盘) web-API client.
 *
 * Auth is the cookie captured from the QR-code sign-in (`UID`, `CID`, `SEID`,
 * `KID`). Requests go through the Tauri HTTP plugin so the native layer can
 * attach the `Cookie` header and bypass the browser CORS rules; the web build
 * cannot use this backend at all because browsers forbid setting `Cookie`.
 *
 * Only the operations the file-sync engine needs are implemented: list, mkdir,
 * delete, download URL, and upload. Uploads use the web client's
 * `sampleinitupload.php` form hand-off to Aliyun OSS, which needs no SHA-1,
 * no second-pass range proof and no request signing.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { FileSyncError, FileSyncErrorCode } from '@/services/sync/file/provider';

const WEBAPI_BASE = 'https://webapi.115.com';
const QRCODE_BASE = 'https://qrcodeapi.115.com';
const UPLB_BASE = 'https://uplb.115.com';
const REQUEST_TIMEOUT_MS = 30_000;
/** Retry budget for transient failures (network, 429, 5xx). */
const MAX_ATTEMPTS = 3;
/**
 * 115 binds a download link to the requesting agent (`f=3` in the signed URL
 * demands the same user-agent and the cookies set by the metadata response).
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

type Json = Record<string, unknown>;

export interface P115Entry {
  name: string;
  cid?: string;
  fid?: string;
  pickCode?: string;
  size?: number;
  isDirectory: boolean;
}

export interface P115QrToken {
  uid: string;
  time: number;
  sign: string;
  /** URL of the QR image to display (the official web endpoint). */
  qrcodeUrl: string;
}

export type P115QrStatus = 0 | 1 | 2 | -1 | -2;

export interface P115DownloadTarget {
  url: string;
  cookies: string[];
}

/** Cookies set by a response, reduced to `name=value` pairs. */
const setCookiePairs = (headers: Headers): string[] => {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raw = getSetCookie ? getSetCookie.call(headers) : headers.get('set-cookie');
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  return values
    .map((value) => value.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='));
};

const isTauri = (): boolean => isTauriAppPlatform();

const nativeFetch: typeof fetch = isTauri()
  ? (tauriFetch as unknown as typeof fetch)
  : (...args: Parameters<typeof fetch>) => fetch(...args);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const errorFrom = (message: string, code: FileSyncErrorCode, status?: number): FileSyncError =>
  new FileSyncError(message, code, status);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 115 signals an expired web session with errno 990001 (or a WAF page), which
 * the engine should treat as a credentials problem so the UI asks for a
 * re-scan instead of showing an opaque network error.
 */
const AUTH_ERRNO = 990001;

/** Map an HTTP status to the engine's neutral error code. */
const codeForStatus = (status: number): FileSyncErrorCode => {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status >= 500) return 'NETWORK';
  return 'UNKNOWN';
};

export interface P115ClientOptions {
  /** Injection points for tests; production uses the Tauri HTTP plugin. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class P115Client {
  readonly kind = 'cookie' as const;
  readonly cookie: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(cookie: string, options: P115ClientOptions = {}) {
    this.cookie = cookie.trim();
    this.fetchFn = options.fetch ?? nativeFetch;
    this.sleepFn = options.sleep ?? sleep;
  }

  get uid(): string {
    const match = /(?:^|;\s*)UID=([^;]+)/.exec(this.cookie);
    return match?.[1] ?? '';
  }

  private async request(
    url: string,
    init: RequestInit = {},
    extraCookies: string[] = [],
    options: { retry?: boolean } = {},
  ): Promise<Response> {
    if (!isTauri()) {
      throw errorFrom('115 Netdisk sync requires the desktop app', 'AUTH_FAILED');
    }
    const retry = options.retry ?? true;
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const headers = new Headers(init.headers);
        headers.set('User-Agent', USER_AGENT);
        const cookie = [this.cookie, ...extraCookies].filter(Boolean).join('; ');
        if (cookie) headers.set('Cookie', cookie);
        const response = await this.fetchFn(url, { ...init, headers, signal: controller.signal });
        const transient = response.status === 429 || response.status >= 500;
        if (retry && transient && attempt < MAX_ATTEMPTS) {
          await this.sleepFn(400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150));
          continue;
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (retry && attempt < MAX_ATTEMPTS) {
          await this.sleepFn(400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150));
          continue;
        }
        throw errorFrom(`115 request failed: ${message}`, 'NETWORK');
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async json(
    url: string,
    init: RequestInit = {},
    requireState = true,
    options: { retry?: boolean } = {},
  ): Promise<Json> {
    const response = await this.request(url, init, [], options);
    const text = await response.text();
    let body: Json;
    try {
      body = JSON.parse(text) as Json;
    } catch {
      const hint =
        response.status === 403 || response.status === 405
          ? ' (115 rejected the request; the login may have expired)'
          : '';
      throw errorFrom(
        `115 returned a non-JSON response (${response.status})${hint}`,
        codeForStatus(response.status),
        response.status,
      );
    }
    const errno = asNumber(body['errno']);
    const state = body['state'];
    const ok = state === true || state === 1;
    if (!response.ok || (requireState && !ok)) {
      let code: FileSyncErrorCode =
        response.status === 401 || response.status === 403
          ? 'AUTH_FAILED'
          : codeForStatus(response.status);
      if (errno === AUTH_ERRNO) code = 'AUTH_FAILED';
      const message =
        errno === AUTH_ERRNO
          ? '115 login expired, scan the QR code again in Settings'
          : (asString(body['error']) ??
            asString(body['message']) ??
            asString(body['msg']) ??
            `115 error (${response.status})`);
      throw errorFrom(`115: ${message}`, code, response.status);
    }
    return body;
  }

  private form(fields: Record<string, string | number>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, String(value));
    return params;
  }

  /** GET the QR token that the settings panel renders. */
  async qrToken(): Promise<P115QrToken> {
    const body = await this.json(`${QRCODE_BASE}/api/1.0/web/1.0/token/`);
    const data = (body['data'] ?? {}) as Json;
    const uid = asString(data['uid']) ?? '';
    const time = asNumber(data['time']) ?? 0;
    const sign = asString(data['sign']) ?? '';
    if (!uid || !sign) throw errorFrom('115 did not return a QR token', 'UNKNOWN');
    const qrcode = asString(data['qrcode']);
    return {
      uid,
      time,
      sign,
      qrcodeUrl: qrcode || `${QRCODE_BASE}/api/1.0/web/1.0/qrcode?uid=${encodeURIComponent(uid)}`,
    };
  }

  /** Poll the scan state: 0 waiting, 1 scanned, 2 confirmed, -1 expired, -2 canceled. */
  async qrStatus(token: Pick<P115QrToken, 'uid' | 'time' | 'sign'>): Promise<P115QrStatus> {
    const query = new URLSearchParams({
      uid: token.uid,
      time: String(token.time),
      sign: token.sign,
    });
    const body = await this.json(`${QRCODE_BASE}/get/status/?${query.toString()}`);
    const data = (body['data'] ?? {}) as Json;
    return (asNumber(data['status']) ?? 0) as P115QrStatus;
  }

  /** Exchange a confirmed scan for the session cookie. */
  async qrLogin(uid: string): Promise<string> {
    const body = await this.json(`${QRCODE_BASE}/app/1.0/web/1.0/login/qrcode/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: this.form({ account: uid }).toString(),
    });
    const cookie = ((body['data'] ?? {}) as Json)['cookie'] as Record<string, unknown> | undefined;
    if (!cookie || typeof cookie !== 'object') {
      throw errorFrom('115 did not return a login cookie', 'AUTH_FAILED');
    }
    return ['UID', 'CID', 'SEID', 'KID']
      .map((key) => `${key}=${asString(cookie[key]) ?? ''}`)
      .join('; ');
  }

  /** List every immediate child of one directory (both files and folders). */
  async listDir(cid = '0'): Promise<P115Entry[]> {
    const entries: P115Entry[] = [];
    let offset = 0;
    for (;;) {
      const query = new URLSearchParams({
        aid: '1',
        cid,
        limit: '1000',
        offset: String(offset),
        show_dir: '1',
      });
      const body = await this.json(`${WEBAPI_BASE}/files?${query.toString()}`);
      const data = body['data'];
      const page = Array.isArray(data) ? (data as Json[]) : [];
      for (const item of page) {
        const name = asString(item['n']) ?? asString(item['file_name']);
        const entryCid = asString(item['cid']);
        if (!name) continue;
        entries.push({
          name,
          cid: entryCid,
          fid: asString(item['fid']),
          pickCode: asString(item['pc']) ?? asString(item['pick_code']),
          size: asNumber(item['s']),
          isDirectory: item['fid'] === undefined && entryCid !== undefined,
        });
      }
      offset += page.length;
      const total = asNumber(body['count']);
      if (page.length === 0 || (total !== undefined && offset >= total)) break;
    }
    return entries;
  }

  async mkdir(parentId: string, name: string): Promise<string> {
    const body = await this.json(
      `${WEBAPI_BASE}/files/add`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.form({ cname: name, pid: parentId }).toString(),
      },
      true,
      { retry: false },
    );
    const cid = asString(body['cid']) ?? asString(((body['data'] ?? {}) as Json)['cid']);
    if (!cid) throw errorFrom(`115 could not create folder ${name}`, 'UNKNOWN');
    return cid;
  }

  async delete(id: string, _parentId?: string): Promise<void> {
    await this.json(
      `${WEBAPI_BASE}/rb/delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.form({ fid: id }).toString(),
      },
      true,
      { retry: false },
    );
  }

  /** Resolve a pick code to a temporary download URL. */
  async downloadUrl(pickCode: string): Promise<P115DownloadTarget> {
    const response = await this.request(
      `${WEBAPI_BASE}/files/download?pickcode=${encodeURIComponent(pickCode)}`,
    );
    const text = await response.text();
    let body: Json;
    try {
      body = JSON.parse(text) as Json;
    } catch {
      throw errorFrom('115 returned a non-JSON download response', codeForStatus(response.status));
    }
    const data = body['data'];
    const url =
      asString(body['file_url']) ??
      (typeof data === 'string' ? data : asString((data as Json | undefined)?.['file_url']));
    if (!response.ok || !url) {
      throw errorFrom('115 did not return a download URL', codeForStatus(response.status));
    }
    // `f=3` links also demand the cookies this metadata response set.
    return { url, cookies: setCookiePairs(response.headers) };
  }

  /** Download a resolved URL with the metadata response's cookies. */
  async download(url: string, cookies: string[] = []): Promise<ArrayBuffer> {
    const response = await this.request(url, {}, cookies);
    if (!response.ok) {
      throw errorFrom(
        `115 download failed (${response.status})`,
        codeForStatus(response.status),
        response.status,
      );
    }
    return response.arrayBuffer();
  }

  /**
   * Upload bytes into a folder via the web client's sample-upload hand-off:
   * the init call returns an OSS host plus the form fields, and posting the
   * file with those fields stores it in the target folder.
   */
  async upload(parentId: string, name: string, bytes: ArrayBuffer): Promise<void> {
    const init = await this.json(
      `${UPLB_BASE}/3.0/sampleinitupload.php`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.form({
          filename: name,
          target: `U_1_${parentId}`,
          path: '',
        }).toString(),
      },
      false,
    );
    const host = asString(init['host']);
    if (!host) throw errorFrom('115 did not return an upload host', 'UNKNOWN');

    // The OSS POST needs these exact field names; the init response calls
    // them object/accessid and the policy/signature/callback are opaque.
    const object = asString(init['object']);
    const accessId = asString(init['accessid']);
    const policy = asString(init['policy']);
    const signature = asString(init['signature']);
    const callback = asString(init['callback']);
    if (!object || !accessId || !policy || !signature || !callback) {
      throw errorFrom('115 did not return a complete upload form', 'UNKNOWN');
    }

    const form = new FormData();
    form.append('name', name);
    form.append('key', object);
    form.append('policy', policy);
    form.append('OSSAccessKeyId', accessId);
    form.append('success_action_status', '200');
    form.append('callback', callback);
    form.append('signature', signature);
    form.append('file', new Blob([bytes]), name);

    const response = await this.request(host, { method: 'POST', body: form });
    const text = await response.text();
    if (!response.ok || /<Error>|<Code>/i.test(text)) {
      throw errorFrom(
        `115 upload failed (${response.status})`,
        codeForStatus(response.status),
        response.status,
      );
    }
  }
}

/** Whether the saved cookie looks complete enough to try. */
export const hasP115Login = (cookie: string | undefined): boolean => {
  if (!cookie) return false;
  return ['UID', 'CID', 'SEID', 'KID'].every((key) =>
    new RegExp(`(?:^|;\\s*)${key}=[^;]+`).test(cookie),
  );
};
