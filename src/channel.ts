import type { EventListenerLike } from './env.js';
import { openBroadcastChannel, type BroadcastChannelLike } from './locks.js';
import type { QueueChannel, QueueChannelMessage } from './types.js';

export function isChannelMessage(value: unknown): value is QueueChannelMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as QueueChannelMessage).type === 'changed' &&
    typeof (value as QueueChannelMessage).source === 'string'
  );
}

/**
 * A channel for queues in one JavaScript realm. Give the same object to every
 * queue that shares a storage object. Messages are delivered asynchronously,
 * to every subscriber; queues ignore their own.
 */
export function createMemoryChannel(): QueueChannel {
  const listeners = new Set<(message: QueueChannelMessage) => void>();
  return {
    postMessage(message) {
      const copy: QueueChannelMessage = { type: message.type, source: message.source };
      Promise.resolve().then(() => listeners.forEach((listener) => listener(copy)));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface BroadcastQueueChannel extends QueueChannel {
  close(): void;
}

/**
 * A channel over `BroadcastChannel`, which reaches every tab, window and
 * worker of the origin. The queue creates one by default in browsers and
 * closes it in `stop()`; close one you create yourself when you are done.
 */
export function createBroadcastQueueChannel(
  name: string,
  createChannel: (name: string) => BroadcastChannelLike = openBroadcastChannel,
): BroadcastQueueChannel {
  const channel = createChannel(name);
  const listeners = new Set<(message: QueueChannelMessage) => void>();
  const onMessage: EventListenerLike = (event) => {
    const data = event && typeof event === 'object' ? (event as { data?: unknown }).data : undefined;
    if (isChannelMessage(data)) listeners.forEach((listener) => listener(data));
  };
  channel.addEventListener('message', onMessage);
  let closed = false;
  return {
    postMessage(message) {
      if (!closed) channel.postMessage({ type: message.type, source: message.source });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      channel.removeEventListener('message', onMessage);
      channel.close();
    },
  };
}
