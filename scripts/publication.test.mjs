import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(root, '.publication-test-'));
const require = createRequire(import.meta.url);
for (const name of ['jwt', 'auth']) {
  const out = ts.transpileModule(fs.readFileSync(path.join(root, 'lib', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(path.join(temp, name + '.cjs'), out.replace("require(\"./jwt\")", "require(\"./jwt.cjs\")"));
}
const auth = require(path.join(temp, 'auth.cjs'));
const jwt = require(path.join(temp, 'jwt.cjs'));
const keys = ['SCHEDULER_USERNAME', 'SCHEDULER_PASSWORD', 'JWT_SECRET'];
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));

test.after(() => {
  for (const k of keys) previous[k] === undefined ? delete process.env[k] : process.env[k] = previous[k];
  fs.rmSync(temp, { recursive: true, force: true });
});

test('missing configuration never grants a session or falls back to a public secret', async () => {
  for (const k of keys) delete process.env[k];
  assert.equal(auth.verifyCredentials('', ''), false);
  assert.throws(() => jwt.jwtSecret());
  assert.equal(await jwt.verifyToken('invalid'), null);
});

test('configured private credentials work; short secrets do not', async () => {
  process.env.SCHEDULER_USERNAME = 'test-user';
  process.env.SCHEDULER_PASSWORD = 'test-only-long-password';
  process.env.JWT_SECRET = 'test-only-secret-with-more-than-32-characters';
  assert.equal(auth.verifyCredentials('test-user', 'test-only-long-password'), true);
  assert.equal(auth.verifyCredentials('test-user', 'incorrect'), false);
  const token = await auth.createSessionToken('test-user');
  assert.equal((await jwt.verifyToken(token)).sub, 'test-user');
  process.env.JWT_SECRET = 'short';
  assert.equal(auth.verifyCredentials('test-user', 'test-only-long-password'), false);
});

test('setup generates unique local credentials and never overwrites an existing file', () => {
  const a = path.join(temp, 'a'), b = path.join(temp, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  for (const cwd of [a, b]) {
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/setup.mjs')], { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  }
  const first = fs.readFileSync(path.join(a, '.env'));
  assert.notDeepEqual(first, fs.readFileSync(path.join(b, '.env')));
  spawnSync(process.execPath, [path.join(root, 'scripts/setup.mjs')], { cwd: a });
  assert.deepEqual(first, fs.readFileSync(path.join(a, '.env')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(a, '.env')).mode & 0o777, 0o600);
});
