import type { LockRequestOptions, QueueLocks } from '../../types';

const never = <T>() => new Promise<T>(() => undefined);

interface Request {
  owner: string;
  grant(release: () => void): void;
}

/**
 * Named exclusive locks shared by several simulated tabs, like
 * `navigator.locks`. `kill(owner)` closes a tab: its held locks are released
 * (as the browser does for a closed tab) and its waiting requests are dropped.
 */
export class FakeLocks {
  private readonly holders = new Map<string, { owner: string; token: object }>();
  private readonly waiting = new Map<string, Request[]>();
  private readonly dead = new Set<string>();

  locksFor(owner: string): QueueLocks {
    return {
      request: <T>(name: string, callback: () => T | PromiseLike<T>, options?: LockRequestOptions): Promise<T> => {
        if (this.dead.has(owner)) return never();
        const signal = options && options.signal;
        return new Promise<T>((resolve, reject) => {
          if (signal && signal.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          const request: Request = {
            owner,
            grant: (release) => {
              Promise.resolve()
                .then(callback)
                .then(
                  (value) => {
                    release();
                    resolve(value);
                  },
                  (error: unknown) => {
                    release();
                    reject(error);
                  },
                );
            },
          };
          const list = this.waiting.get(name) || [];
          list.push(request);
          this.waiting.set(name, list);
          if (signal) {
            signal.addEventListener('abort', () => {
              const current = this.waiting.get(name);
              const index = current ? current.indexOf(request) : -1;
              if (current && index >= 0) {
                current.splice(index, 1);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              }
            });
          }
          this.next(name);
        });
      },
    };
  }

  holder(name: string): string | undefined {
    const held = this.holders.get(name);
    return held && held.owner;
  }

  private next(name: string): void {
    if (this.holders.has(name)) return;
    const list = this.waiting.get(name);
    if (!list || list.length === 0) return;
    const request = list.shift() as Request;
    const token = {};
    this.holders.set(name, { owner: request.owner, token });
    request.grant(() => {
      const held = this.holders.get(name);
      if (held && held.token === token) {
        this.holders.delete(name);
        this.next(name);
      }
    });
  }

  kill(owner: string): void {
    this.dead.add(owner);
    this.waiting.forEach((list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) list.splice(i, 1);
    });
    Array.from(this.holders.entries()).forEach(([name, held]) => {
      if (held.owner === owner) {
        this.holders.delete(name);
        this.next(name);
      }
    });
  }
}
