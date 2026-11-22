import type { QueueItem, QueueItemStatus } from './types.js';

export type QueueCounts = Record<QueueItemStatus, number> & { total: number };

/** The number of items in each status, and `total`. */
export function countItems(items: readonly QueueItem<unknown>[]): QueueCounts {
  const counts: QueueCounts = { pending: 0, inflight: 0, succeeded: 0, failed: 0, dead: 0, total: items.length };
  for (const item of items) counts[item.status]++;
  return counts;
}
