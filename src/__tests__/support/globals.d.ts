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
declare class Headers {
  constructor(init?: Record<string, string> | Array<[string, string]>);
  get(name: string): string | null;
  forEach(callback: (value: string, name: string) => void): void;
}
declare class Blob {
  constructor(parts: string[]);
  readonly size: number;
}
declare class FormData {
  append(name: string, value: string): void;
}
declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  toString(): string;
}
declare const require: (name: string) => unknown;
