import * as React from 'react';
import { countItems, type QueueCounts } from './counts.js';
import type { QueueItem } from './types.js';

export { countItems };
export type { QueueCounts };

export interface QueueItemsState<TPayload = unknown> {
  items: readonly QueueItem<TPayload>[];
  counts: QueueCounts;
}

/** The two queue methods the hook reads. Every `IdempotentQueue<TPayload, TResult>` fits. */
export interface QueueItemsSource<TPayload = unknown> {
  getItems(): readonly QueueItem<TPayload>[];
  subscribe(listener: () => void): () => void;
}

type Source<TPayload> = QueueItemsSource<TPayload>;

type UseSyncExternalStore = <T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T) => T;

/** React 18+ path. */
export function useItemsWithSyncExternalStore<TPayload>(
  queue: Source<TPayload>,
  useSyncExternalStore: UseSyncExternalStore,
): readonly QueueItem<TPayload>[] {
  const subscribe = React.useCallback((onChange: () => void) => queue.subscribe(() => onChange()), [queue]);
  const getSnapshot = React.useCallback(() => queue.getItems(), [queue]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** React 16.8 and 17 path: subscribe in an effect and re-read the snapshot. */
export function useItemsWithEffect<TPayload>(queue: Source<TPayload>): readonly QueueItem<TPayload>[] {
  const [, forceRender] = React.useReducer((count: number) => count + 1, 0);
  const items = queue.getItems();
  const rendered = React.useRef(items);
  rendered.current = items;
  React.useEffect(() => {
    const check = () => {
      // getItems() returns the same array until something changes.
      if (queue.getItems() !== rendered.current) forceRender();
    };
    const unsubscribe = queue.subscribe(check);
    // Catch changes made between render and subscription.
    check();
    return unsubscribe;
  }, [queue]);
  return items;
}

const builtInSyncExternalStore = (React as unknown as { useSyncExternalStore?: UseSyncExternalStore })
  .useSyncExternalStore;

/**
 * The queue's items and a count per status, re-rendering on every change,
 * including changes made by other tabs once the queue is started. Uses
 * `useSyncExternalStore` on React 18+ and an effect subscription on React
 * 16.8 and 17.
 */
export function useQueueItems<TPayload = unknown>(queue: QueueItemsSource<TPayload>): QueueItemsState<TPayload> {
  const items = builtInSyncExternalStore
    ? useItemsWithSyncExternalStore(queue, builtInSyncExternalStore)
    : useItemsWithEffect(queue);
  return React.useMemo(() => ({ items, counts: countItems(items) }), [items]);
}
