// The build targets ES2017 without DOM or Node typings, so the few host
// globals the library touches are declared here. Everything else (navigator,
// document, indexedDB, BroadcastChannel, fetch) is read through `env.ts`,
// defensively, at runtime.
declare const console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
