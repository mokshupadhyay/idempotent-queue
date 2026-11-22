// Host globals used by tests only. The library itself reads these through `env.ts`.
declare class AbortSignal {
  static abort(): AbortSignal;
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}
