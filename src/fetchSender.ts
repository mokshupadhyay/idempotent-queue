import { HttpError } from './classify.js';
import { readGlobal } from './env.js';
import { isPageHidden } from './page.js';
import type { QueueItem, SendContext } from './types.js';

/** The subset of `fetch`'s `RequestInit` the sender sets or passes through. */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  keepalive?: boolean;
  [option: string]: unknown;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>;

export interface FetchSenderOptions {
  /** Header that carries the idempotency key. Default `'Idempotency-Key'`. */
  headerName?: string;
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  /**
   * Sets `keepalive` on the request, so it can finish after the page is
   * closed or navigated away from.
   *
   * - `true`: on every request.
   * - `'pagehide'`: only on requests that start while the page is hidden or
   *   being unloaded (after `pagehide`, or `visibilityState === 'hidden'`).
   * - `false` or omitted: never (an `init.keepalive` you pass is kept).
   *
   * Browsers refuse a keepalive request whose body, together with the other
   * keepalive requests in flight, exceeds 64 KiB. A string body larger than
   * that is sent without `keepalive` instead of failing on every attempt.
   */
  keepalive?: boolean | 'pagehide';
}

/** Browsers cap the bodies of keepalive requests in flight at 64 KiB in total. */
export const KEEPALIVE_BODY_LIMIT = 64 * 1024;

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === '') return undefined;
  if (contentType && /[/+]json\b/i.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * A `send` function built on `fetch`. Each attempt:
 *
 * - uses `init.method`, or `POST`;
 * - sets the `Idempotency-Key` header (or `headerName`) to the item's key;
 * - sends `item.payload` as the body: strings as they are, anything else as
 *   JSON with `Content-Type: application/json` unless you set one;
 * - sets `keepalive` as `options.keepalive` says;
 * - resolves with the response body (parsed when it is JSON) for 2xx, and
 *   throws an `HttpError` with `status`, `headers` and `body` otherwise, which
 *   `defaultClassifyError` understands. A network failure rejects as `fetch` does.
 *
 * The server has to honour the header: store the first response per key and
 * replay it for repeated keys, without repeating the effect. Without that, a
 * retry after a lost response repeats the effect.
 *
 * `url` and `init` may be functions of the item.
 */
export function fetchSender<TPayload = unknown, TResult = unknown>(
  url: string | ((item: QueueItem<TPayload>) => string),
  init?: FetchInit | ((item: QueueItem<TPayload>) => FetchInit),
  options: FetchSenderOptions = {},
): (item: QueueItem<TPayload>, context: SendContext) => Promise<TResult> {
  const headerName = options.headerName || 'Idempotency-Key';
  return async (item, context) => {
    const globalFetch = readGlobal('fetch');
    const doFetch: FetchLike | undefined =
      options.fetch || (typeof globalFetch === 'function' ? (globalFetch as FetchLike) : undefined);
    if (!doFetch) throw new Error('fetchSender: no fetch implementation is available');
    const base = (typeof init === 'function' ? init(item) : init) || {};
    const headers: Record<string, string> = {};
    let hasContentType = false;
    const given = base.headers || {};
    for (const name of Object.keys(given)) {
      // Never let a caller's header override the item's key.
      if (name.toLowerCase() === headerName.toLowerCase()) continue;
      if (name.toLowerCase() === 'content-type') hasContentType = true;
      headers[name] = given[name];
    }
    headers[headerName] = context.key;
    let body: unknown = base.body;
    if (body === undefined) {
      if (typeof item.payload === 'string') {
        body = item.payload;
      } else {
        body = JSON.stringify(item.payload);
        if (!hasContentType) headers['Content-Type'] = 'application/json';
      }
    }
    const request: Record<string, unknown> = { ...base, method: base.method || 'POST', headers, body };
    const mode = options.keepalive;
    if (mode === true || (mode === 'pagehide' && isPageHidden())) {
      const fits = typeof body !== 'string' || utf8Length(body) <= KEEPALIVE_BODY_LIMIT;
      if (fits) request.keepalive = true;
    }
    const response = await doFetch(typeof url === 'function' ? url(item) : url, request);
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    const parsed = parseBody(text, response.headers ? response.headers.get('Content-Type') : null);
    if (!response.ok) {
      throw new HttpError(
        response.status,
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        response.headers,
        parsed,
      );
    }
    return parsed as TResult;
  };
}
