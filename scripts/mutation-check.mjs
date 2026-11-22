// Mutation check for the property tests. For each property: back up the
// source file, apply one small deliberate break, run that property and expect
// it to FAIL, restore the backup, and confirm with `cmp` that the source is
// byte-identical to the backup. Run with `timeout 1800 node scripts/mutation-check.mjs`.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jest = require.resolve('jest/bin/jest');
/** Each jest run is killed after this long, so a mutation that hangs counts as a failure to report, not a stuck script. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

const mutations = [
  {
    property: 'property 1',
    description: 'Do not return inflight items left by a closed tab to pending',
    file: 'src/queue.ts',
    find: "if (item.status === 'inflight' && !ownIds.has(item.id)) {",
    replace: "if (false && item.status === 'inflight' && !ownIds.has(item.id)) {",
  },
  {
    property: 'property 1',
    description: 'Drop the dedupe by key in enqueue',
    file: 'src/queue.ts',
    find: '      if (existing) {',
    replace: '      if (existing && false) {',
  },
  {
    property: 'property 2',
    description: 'Drop the in-flight key guard when picking due items',
    file: 'src/queue.ts',
    find: 'if (inflightKeys.has(item.key) || claimedKeys.has(item.key)) return;',
    replace: 'if (claimedKeys.has(item.key)) return;',
  },
  {
    property: 'property 3',
    description: 'Off-by-one in the maxAttempts check (`>=` becomes `>`)',
    file: 'src/queue.ts',
    find: '} else if (item.attempts >= policy.maxAttempts) {',
    replace: '} else if (item.attempts > policy.maxAttempts) {',
  },
  {
    property: 'property 4',
    description: 'Off-by-one when recovering an interrupted last attempt (`>=` becomes `>`)',
    file: 'src/queue.ts',
    find: '    if (item.attempts >= policy.maxAttempts) {\n      return {',
    replace: '    if (item.attempts > policy.maxAttempts) {\n      return {',
  },
  {
    property: 'property 5',
    description: 'Release the sender lock as soon as it is granted',
    file: 'src/queue.ts',
    find: '      return new Promise<void>((resolve) => {\n        resign = resolve;',
    replace: '      void new Promise<void>((resolve) => {\n        resign = resolve;',
  },
  {
    property: 'property 6',
    description: "Ignore other tabs' change notifications",
    file: 'src/queue.ts',
    find: 'if (message.source !== instanceId) refresh();',
    replace: 'if (false) refresh();',
  },
  {
    property: 'property 7',
    description: 'Do not clamp huge or infinite classifier delays',
    file: 'src/queue.ts',
    find: '  if (delay > MAX_CLASSIFIED_DELAY_MS) delay = maxDelayMs;',
    replace: '',
  },
  {
    property: 'property 8',
    description: 'Skip the load validation before a write',
    file: 'src/persistence.ts',
    find: '  if (reason) throw new InvalidStateError(reason);',
    replace: '  if (false && reason) throw new InvalidStateError(reason);',
  },
];

const backupDir = mkdtempSync(join(tmpdir(), 'idempotent-queue-mutation-'));
const results = [];

for (const [index, mutation] of mutations.entries()) {
  const backup = join(backupDir, `${index}-${mutation.file.replace(/\//g, '_')}`);
  copyFileSync(mutation.file, backup);
  const source = readFileSync(mutation.file, 'utf8');
  const occurrences = source.split(mutation.find).length - 1;
  if (occurrences !== 1) throw new Error(`${mutation.description}: expected 1 match, found ${occurrences}`);
  let run;
  try {
    writeFileSync(mutation.file, source.replace(mutation.find, mutation.replace));
    run = spawnSync(
      process.execPath,
      [jest, 'src/__tests__/properties.test.ts', '-t', `${mutation.property}:`, '--ci'],
      {
        encoding: 'utf8',
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, NUM_RUNS: process.env.NUM_RUNS || '120' },
      },
    );
  } finally {
    copyFileSync(backup, mutation.file);
  }
  // `cmp` exits non-zero (and execFileSync throws) if the restore is not byte-identical.
  execFileSync('cmp', [mutation.file, backup]);
  const output = `${run.stdout}\n${run.stderr}`;
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  const ran = /Tests:.*1 failed/.test(output) || /Tests:.*1 passed/.test(output);
  const failed = run.status !== 0 && ran && !timedOut;
  const after = (output.match(/Property failed after (\d+) tests/) || [])[1];
  const counterexample = (output.match(/Counterexample: (.*)/) || [])[1];
  const cause = (output.match(/(Expected[^\n]*)\n\s*(Received[^\n]*)/) || []).slice(1, 3);
  results.push({ ...mutation, failed, timedOut, after, counterexample, cause: cause.join(' / ') });
  console.log(
    `${mutation.property}: ${mutation.description}\n` +
      `  property ${failed ? 'FAILED as expected' : timedOut ? 'TIMED OUT' : 'PASSED (mutation survived)'}` +
      (after ? ` after ${after} cases` : '') +
      `\n  cause: ${results[results.length - 1].cause}\n` +
      `  counterexample: ${counterexample ? counterexample.slice(0, 400) : ''}\n` +
      `  restored: cmp ${mutation.file} ${backup} -> identical\n`,
  );
}

const clean = spawnSync(process.execPath, [jest, 'src/__tests__/properties.test.ts', '--ci'], {
  encoding: 'utf8',
  timeout: RUN_TIMEOUT_MS,
});
console.log(`unmutated properties: ${clean.status === 0 ? 'all pass' : 'FAIL'}`);
writeFileSync(join(backupDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(`results: ${join(backupDir, 'results.json')}`);
if (results.some((result) => !result.failed) || clean.status !== 0) process.exit(1);
