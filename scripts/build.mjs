import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

const run = (...args) =>
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', ...args], {
    stdio: 'inherit',
  });

rmSync('lib', { recursive: true, force: true });

// ES2017 output keeps optional chaining and nullish coalescing out of the
// shipped JavaScript, so older bundlers and browsers can parse it. The classic
// JSX transform keeps React 16.8 compatibility.
run('--module', 'commonjs', '--outDir', 'lib/commonjs');
run('--module', 'esnext', '--outDir', 'lib/module');
const declarations = (outDir) =>
  run('--declaration', '--emitDeclarationOnly', '--sourceMap', 'false', '--outDir', outDir);
declarations('lib/typescript/commonjs');
declarations('lib/typescript/module');

// The package root has no "type" field, so .js files are CommonJS by default.
// These markers make Node and TypeScript read the ESM build (and its types) as ESM.
const markModule = (dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
};
markModule('lib/module');
markModule('lib/typescript/module');
