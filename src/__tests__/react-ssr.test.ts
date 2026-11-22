import { createIdempotentQueue } from '../queue';
import { createMemoryStorage } from '../storage';
import type { IdempotentQueue } from '../types';

/*
 * Server rendering of `useQueueItems` with `react-dom/server` on React 19, 18
 * and 17. React 18 and 17 are installed under the aliases `react-18`,
 * `react-dom-18`, `react-17` and `react-dom-17`; each test loads the hook with
 * `react` mapped to the matching version.
 */

type ReactLike = { version: string; createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown };
type Hook = (queue: IdempotentQueue) => { counts: { pending: number; total: number } };

function load(reactName: string, domName: string) {
  let React!: ReactLike;
  let renderToString!: (element: unknown) => string;
  let useQueueItems!: Hook;
  jest.isolateModules(() => {
    jest.doMock('react', () => jest.requireActual(reactName));
    React = require('react') as ReactLike;
    renderToString = (require(`${domName}/server`) as { renderToString(element: unknown): string }).renderToString;
    useQueueItems = (require('../react') as { useQueueItems: Hook }).useQueueItems;
  });
  return { React, renderToString, useQueueItems };
}

describe.each([
  ['19', 'react', 'react-dom', /^19\./],
  ['18', 'react-18', 'react-dom-18', /^18\./],
  ['17', 'react-17', 'react-dom-17', /^17\./],
])('useQueueItems with renderToString on React %s', (_label, reactName, domName, version) => {
  afterEach(() => jest.restoreAllMocks());

  it('renders on the server without errors', async () => {
    const errors: unknown[][] = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
    const { React, renderToString, useQueueItems } = load(reactName, domName);
    expect(React.version).toMatch(version);
    const queue = createIdempotentQueue({ storage: createMemoryStorage(), send: async () => 1, channel: null });
    await queue.enqueue({ payload: 1, key: 'k' });
    function Pending() {
      const { counts } = useQueueItems(queue);
      return React.createElement('span', null, `${counts.pending}/${counts.total}`);
    }
    const html = renderToString(React.createElement(Pending));
    // React 18+ renders the server snapshot (no items: the server cannot see the browser's storage).
    // React 17 has no useSyncExternalStore; the effect path renders the queue as it is.
    expect(html.replace(' data-reactroot=""', '')).toBe(reactName === 'react-17' ? '<span>1/1</span>' : '<span>0/0</span>');
    expect(errors).toEqual([]);
  });
});
