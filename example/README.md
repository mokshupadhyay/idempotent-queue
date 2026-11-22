# Example: two tabs sharing one queue

This page is not part of the published package. It loads the built library from `../lib/module`, so build it first and serve the repository root over `http://localhost`. Web Locks and `crypto.randomUUID` need a secure context, and `localhost` counts as one.

```sh
npm install
npm run build
timeout 3600 python3 -m http.server 8080 --bind 127.0.0.1   # or any static file server
```

Open <http://localhost:8080/example/>. Each of the two frames runs its own queue, as a tab would, and they share IndexedDB, Web Locks and BroadcastChannel. Try these:

- **Pay €25** in either frame. The frame that holds the sender lock sends the payment, and both frames show the item.
- **Pay again with the same key**: the existing item is returned and nothing new is sent.
- **Close** the sending frame while a payment is in flight. The other frame takes the sender lock and sends the same key again. The pretend server (`server.js`, kept in `localStorage`) counts two requests and one payment.

You can also open <http://localhost:8080/example/tab.html> in two real browser tabs.

`http://localhost:8080/example/?selftest` runs that sequence by itself and shows `PASS` or `FAIL`. It also requests `/selftest-result?…`, so the result appears in the server's log. Add `&nolocks` to hide `navigator.locks` and use the BroadcastChannel lock fallback instead.
