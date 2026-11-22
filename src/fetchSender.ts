import { HttpError } from './classify.js';
import { readGlobal } from './env.js';
import { isPageHidden } from './page.js';
import type { QueueItem, SendContext } from './types.js';

/** Every shape `fetch` accepts for headers: a record, an array of `[name, value]` pairs, or a `Headers` object. */
export type HeadersInitLike =
  | Record<string, string>
  | ReadonlyArray<readonly [string, string]>
  | { forEach(callback: (value: string, name: string) => void): void };

/** The subset of `fetch`'s `RequestInit` the sender sets or passes through. */
export interface FetchInit {
  method?: string;
  headers?: HeadersInitLike;
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
   * keepalive requests in flight, exceeds 64 KiB. So `keepalive` is set only
   * when the body's size is known (a string, `Blob`, `ArrayBuffer`, typed
   * array, `DataView` or `URLSearchParams`) and fits in what is left of
   * 64 KiB after the keepalive requests this page already has in flight.
   * Otherwise (a `FormData` or a stream, or no room left) the request is
   * sent normally instead of failing on every attempt.
   */
  keepalive?: boolean | 'pagehide';
}

/** Browsers cap the bodies of keepalive requests in flight at 64 KiB in total. */
export const KEEPALIVE_BODY_LIMIT = 64 * 1024;

/** Bytes of keepalive bodies this page has in flight, across every `fetchSender`. */
let keepaliveInFlight = 0;

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

const tag = (value: unknown) => Object.prototype.toString.call(value);

/** The size in bytes of a fetch body, or `undefined` when it cannot be known without reading it. */
export function bodySize(body: unknown): number | undefined {
  if (body == null) return 0;
  if (typeof body === 'string') return utf8Length(body);
  if (typeof body !== 'object') return undefined;
  const kind = tag(body);
  if (kind === '[object URLSearchParams]') return utf8Length(String(body));
  if (kind === '[object FormData]' || kind === '[object ReadableStream]') return undefined;
  const { byteLength, size } = body as { byteLength?: unknown; size?: unknown };
  // ArrayBuffer, typed arrays and DataView.
  if (typeof byteLength === 'number') return byteLength;
  // Blob and File.
  if (typeof size === 'number' && typeof (body as { slice?: unknown }).slice === 'function') return size;
  return undefined;
}

/** Copies headers in any `HeadersInitLike` shape into `[name, value]` pairs. */
function headerPairs(headers: HeadersInitLike | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (!headers) return pairs;
  if (Array.isArray(headers)) {
    for (const pair of headers as ReadonlyArray<readonly [string, string]>) {
      if (pair && pair.length >= 2) pairs.push([String(pair[0]), String(pair[1])]);
    }
  } else if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach(callback: (value: string, name: string) => void): void }).forEach((value, name) =>
      pairs.push([name, value]),
    );
  } else {
    const record = headers as Record<string, string>;
    for (const name of Object.keys(record)) pairs.push([name, record[name]]);
  }
  return pairs;
}

/** Combines the caller's signal with the queue's, so either one aborts the request. */
function combineSignals(own: unknown, queue: unknown): unknown {
  if (own === undefined) return queue;
  if (queue === undefined) return own;
  const Signal = readGlobal('AbortSignal') as { any?: (signals: unknown[]) => unknown } | undefined;
  if (Signal && typeof Signal.any === 'function') return Signal.any([own, queue]);
  // Without AbortSignal.any, the queue's signal wins: it enforces attemptTimeoutMs and stop().
  return queue;
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
    for (const [name, value] of headerPairs(base.headers)) {
      // Never let a caller's header override the item's key.
      if (name.toLowerCase() === headerName.toLowerCase()) continue;
      if (name.toLowerCase() === 'content-type') hasContentType = true;
      // Repeated names are joined, as `Headers` does.
      headers[name] = Object.prototype.hasOwnProperty.call(headers, name) ? `${headers[name]}, ${value}` : value;
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
    const signal = combineSignals(base.signal, context.signal);
    if (signal !== undefined) request.signal = signal;
    const mode = options.keepalive;
    let reserved = 0;
    if (mode === true || (mode === 'pagehide' && isPageHidden())) {
      const size = bodySize(body);
      if (size !== undefined && keepaliveInFlight + size <= KEEPALIVE_BODY_LIMIT) {
        request.keepalive = true;
        reserved = size;
        keepaliveInFlight += size;
      }
    }
    let response: FetchResponseLike;
    try {
      response = await doFetch(typeof url === 'function' ? url(item) : url, request);
    } finally {
      // The browser counts a keepalive body until the response arrives.
      keepaliveInFlight -= reserved;
    }
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
