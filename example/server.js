// A pretend payment API that lives in localStorage, so every tab of the
// example talks to the same "server". It honours the Idempotency-Key header:
// the first request with a key applies the payment and stores the answer;
// later requests with that key get the stored answer and change nothing.

const ledgerKey = (storageKey) => `${storageKey}:fake-server`;

export function readLedger(storageKey) {
  const raw = localStorage.getItem(ledgerKey(storageKey));
  return raw ? JSON.parse(raw) : { requests: {}, payments: {} };
}

export function resetLedger(storageKey) {
  localStorage.removeItem(ledgerKey(storageKey));
}

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify(body),
});

/** A `fetch` for `fetchSender`. The payment is applied when the request arrives; the answer comes `latencyMs` later. */
export function fakeServerFetch(storageKey, latencyMs) {
  return async (_url, init) => {
    const key = init.headers['Idempotency-Key'];
    if (!key) return response(400, { error: 'missing Idempotency-Key' });
    const ledger = readLedger(storageKey);
    ledger.requests[key] = (ledger.requests[key] || 0) + 1;
    if (!ledger.payments[key]) ledger.payments[key] = { ...JSON.parse(init.body), receipt: `rcpt_${Object.keys(ledger.payments).length + 1}` };
    localStorage.setItem(ledgerKey(storageKey), JSON.stringify(ledger));
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return response(200, ledger.payments[key]);
  };
}
