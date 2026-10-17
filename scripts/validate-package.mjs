import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run using npm run validate:package');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const temp = await mkdtemp(path.join(os.tmpdir(), 'staleprobe-consumer-'));
try {
  const dry = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], root))[0];
  const names = dry.files.map(file => file.path);
  for (const required of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts', 'README.md', 'LICENSE']) assert.ok(names.includes(required), required);
  assert.ok(names.every(name => !/node_modules|\.env$|\.test\.|package-lock/.test(name)));
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root))[0];
  await writeFile(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)], temp);
  const consumer = `import assert from 'node:assert/strict';
import { createAuditor, createIoredisAdapter } from 'staleprobe';
const events = [];
const client = { async get() { return '1'; } };
const auditor = createAuditor({ sampleRate: 1, exporter: false, onResult: event => { events.push(event); } });
const cache = auditor.wrap(createIoredisAdapter(client), { rules: [{ pattern: '*', loader: async () => 1 }] });
assert.equal(await cache.get('sensitive-key'), '1');
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
assert.equal(events[0].result, 'FRESH');
await auditor.shutdown();
`;
  await writeFile(path.join(temp, 'consumer.mjs'), consumer);
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: temp, stdio: 'inherit' });
  execFileSync(process.execPath, ['-e', `const assert = require('node:assert/strict'); const s = require('staleprobe'); assert.equal(typeof s.createAuditor, 'function'); assert.throws(() => require.resolve('ioredis'), {code:'MODULE_NOT_FOUND'}); s.createAuditor({exporter:false}).shutdown();`], { cwd: temp, stdio: 'inherit' });
  await writeFile(path.join(temp, 'types.mjs'), `// @ts-check
import { createAuditor, createIoredisAdapter } from 'staleprobe';
const audit = createAuditor({sampleRate: .1});
const cache = audit.wrap(createIoredisAdapter({async get(key) { return key; }}), {rules: [{pattern: '*', loader: async (key, signal) => { signal.throwIfAborted(); return key; }}]});
cache.get('key').then(value => value?.toUpperCase());
// @ts-expect-error sampleRate must be numeric
createAuditor({sampleRate: 'wrong'});
audit.shutdown();
`);
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--allowJs', '--checkJs', '--strict', '--noImplicitAny', 'false', '--module', 'nodenext', '--target', 'es2022', 'types.mjs'], { cwd: temp, stdio: 'inherit' });
  // Compile the exact README quick start against installed declarations + optional peer.
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const snippet = readme.match(/```ts\n([\s\S]*?)```/)[1];
  assert.ok(snippet.trim().split('\n').length < 30);
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', 'ioredis@^5', '@types/node@^20'], temp);
  await writeFile(path.join(temp, 'quickstart.mts'), snippet);
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--esModuleInterop', '--module', 'nodenext', '--target', 'es2022', 'quickstart.mts'], { cwd: temp, stdio: 'inherit' });
  // Run the unchanged snippet with a module-loader fixture, without its illustrative HTTP backend.
  await writeFile(path.join(temp, 'readme-loader.mjs'), `
const redisFixture = 'export class Redis { async get() { return JSON.stringify({id:123}); } async quit() {} }';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ioredis') return {url: 'data:text/javascript,' + encodeURIComponent(redisFixture), shortCircuit: true};
  return nextResolve(specifier, context);
}
`);
  await writeFile(path.join(temp, 'quickstart.mjs'), snippet);
  execFileSync(process.execPath, ['--no-warnings', '--loader', './readme-loader.mjs', 'quickstart.mjs'], { cwd: temp, stdio: 'inherit' });
  console.log(`Validated ${names.length} packed files (${dry.unpackedSize} unpacked bytes); ESM, CommonJS, JS declarations, optional peer absence and README quick start types/mock execution passed.`);
} finally {
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('staleprobe-consumer-'));
  await rm(temp, { recursive: true, force: true });
}
execFileSync(process.execPath, [path.join(root, 'scripts/validate-config.mjs')], { cwd: root, stdio: 'inherit' });
