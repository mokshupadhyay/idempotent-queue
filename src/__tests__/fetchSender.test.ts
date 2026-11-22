import { defaultClassifyError, HttpError } from '../classify';
import { fetchSender, KEEPALIVE_BODY_LIMIT, type FetchLike } from '../fetchSender';
import { resetPageStateForTests } from '../page';
import { createIdempotentQueue } from '../queue';
import { createMemoryStorage } from '../storage';
import type { QueueItem } from '../types';

function response(status: number, body = '', headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  Object.keys(headers).forEach((name) => (lower[name.toLowerCase()] = headers[name]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name: string) => lower[name.toLowerCase()] || null },
    text: async () => body,
  };
}

const item = (payload: unknown, key = 'key-1'): QueueItem => ({
  id: 'id-1',
  key,
  payload,
  status: 'inflight',
  attempts: 1,
  sequence: 1,
  createdAt: 0,
  updatedAt: 0,
  nextAttemptAt: 0,
});

describe('fetchSender', () => {
  it('posts the payload as JSON with the Idempotency-Key header', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      response(201, '{"id":"pay_1"}', { 'Content-Type': 'application/json; charset=utf-8' }),
    );
    const send = fetchSender('https://api.example.com/payments', { headers: { Authorization: 'Bearer t' } }, { fetch });
    const result = await send(item({ amount: 5 }), { key: 'key-1', attempt: 1 });
    expect(result).toEqual({ id: 'pay_1' });
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Idempotency-Key': 'key-1', 'Content-Type': 'application/json' },
      body: '{"amount":5}',
    });
  });

  it('never lets a caller header replace the key, and keeps a custom content type', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => response(200, 'done'));
    const send = fetchSender(
      (queued) => `https://api.example.com/orders/${(queued.payload as { order: string }).order}`,
      () => ({ method: 'PUT', headers: { 'idempotency-key': 'stale', 'content-type': 'application/vnd+json' } }),
      { fetch, headerName: 'X-Request-Id' },
    );
    expect(await send(item({ order: 'o1' }), { key: 'fresh', attempt: 2 })).toBe('done');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/orders/o1');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'idempotency-key': 'stale', 'content-type': 'application/vnd+json', 'X-Request-Id': 'fresh' });
  });

  it('removes a caller header with the same name as the key header', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => response(204));
    const send = fetchSender('u', { headers: { 'idempotency-key': 'stale' } }, { fetch });
    expect(await send(item('raw text'), { key: 'fresh', attempt: 1 })).toBeUndefined();
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { 'Idempotency-Key': 'fresh' }, body: 'raw text' });
  });

  it('throws an HttpError the default classifier understands', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      response(429, '{"error":"slow down"}', { 'Retry-After': '7', 'Content-Type': 'application/json' }),
    );
    const send = fetchSender('u', undefined, { fetch });
    const error = await send(item(1), { key: 'k', attempt: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, body: { error: 'slow down' }, message: 'HTTP 429 Error' });
    expect(defaultClassifyError(error, { now: 0 })).toEqual({ type: 'rateLimited', delayMs: 7000 });
  });

  it('lets network failures reject as fetch does', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const send = fetchSender('u', undefined, { fetch });
    await expect(send(item(1), { key: 'k', attempt: 1 })).rejects.toThrow('Failed to fetch');
  });

  it('uses the global fetch by default', async () => {
    const global = globalThis as { fetch?: unknown };
    const original = global.fetch;
    global.fetch = jest.fn(async () => response(200, 'ok'));
    try {
      expect(await fetchSender('u')(item(1), { key: 'k', attempt: 1 })).toBe('ok');
    } finally {
      global.fetch = original;
    }
  });

  it('works as the queue sender end to end', async () => {
    const seen: string[] = [];
    let calls = 0;
    const fetch: FetchLike = async (_url, init) => {
      seen.push((init.headers as Record<string, string>)['Idempotency-Key']);
      calls++;
      return calls === 1 ? response(503) : response(200, '{"ok":true}', { 'content-type': 'application/json' });
    };
    let now = 0;
    const queue = createIdempotentQueue({
      storage: createMemoryStorage(),
      send: fetchSender('u', undefined, { fetch }),
      now: () => now,
      random: () => 0,
      timers: { setTimeout: (callback) => Promise.resolve().then(callback), clearTimeout: () => undefined },
    });
    await queue.start();
    await queue.enqueue({ payload: { amount: 1 }, key: 'pay-1' });
    for (let i = 0; i < 100 && queue.getItems()[0].status !== 'succeeded'; i++) {
      now += 1;
      await Promise.resolve();
    }
    expect(queue.getItems()[0].status).toBe('succeeded');
    expect(seen).toEqual(['pay-1', 'pay-1']);
    await queue.stop();
  });
});

describe('fetchSender keepalive', () => {
  type Listener = (event: unknown) => void;
  const global = globalThis as { window?: unknown; document?: unknown };

  function fakePage(visibilityState: string) {
    const listeners = new Map<string, Listener[]>();
    const window = {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, (listeners.get(type) || []).concat([listener])),
      removeEventListener: () => undefined,
    };
    const document = { visibilityState, addEventListener: () => undefined, removeEventListener: () => undefined };
    global.window = window;
    global.document = document;
    resetPageStateForTests();
    return { document, fire: (type: string) => (listeners.get(type) || []).forEach((listener) => listener({ type })) };
  }

  afterEach(() => {
    delete global.window;
    delete global.document;
    resetPageStateForTests();
  });

  const run = async (options: Parameters<typeof fetchSender>[2], payload: unknown = { a: 1 }) => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => response(200));
    await fetchSender('u', undefined, { ...options, fetch })(item(payload), { key: 'k', attempt: 1 });
    return fetch.mock.calls[0][1];
  };

  it('sets keepalive on every request with keepalive: true', async () => {
    expect(await run({ keepalive: true })).toMatchObject({ keepalive: true });
    expect(await run({})).not.toHaveProperty('keepalive');
  });

  it("sets keepalive only while the page is hidden or unloading with keepalive: 'pagehide'", async () => {
    const page = fakePage('visible');
    expect(await run({ keepalive: 'pagehide' })).not.toHaveProperty('keepalive');
    page.fire('pagehide');
    expect(await run({ keepalive: 'pagehide' })).toMatchObject({ keepalive: true });
    page.fire('pageshow');
    expect(await run({ keepalive: 'pagehide' })).not.toHaveProperty('keepalive');
    page.document.visibilityState = 'hidden';
    expect(await run({ keepalive: 'pagehide' })).toMatchObject({ keepalive: true });
  });

  it('sends a body over the keepalive limit without keepalive instead of failing', async () => {
    const small = 'x'.repeat(KEEPALIVE_BODY_LIMIT);
    expect(await run({ keepalive: true }, small)).toMatchObject({ keepalive: true });
    expect(await run({ keepalive: true }, small + 'x')).not.toHaveProperty('keepalive');
    // Multi-byte characters count as their UTF-8 length.
    expect(await run({ keepalive: true }, '\u00e9'.repeat(KEEPALIVE_BODY_LIMIT / 2 + 1))).not.toHaveProperty('keepalive');
  });
});
