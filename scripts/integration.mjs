/** 仅为测试创建独立临时数据库、私有凭据和空闲 loopback 端口。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-public-test-'));
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1',
  SCHEDULER_USERNAME: 'test-' + crypto.randomBytes(4).toString('hex'),
  SCHEDULER_PASSWORD: crypto.randomBytes(18).toString('hex'),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  SCHEDULER_DB: path.join(temp, 'scheduler.db'), SCHEDULER_BACKUP_DIR: path.join(temp, 'backups'),
  SELFTEST_BASE: `http://127.0.0.1:${port}`, SCHEDULER_TEST_ISOLATED: '1',
};
env.SELFTEST_USER = env.SCHEDULER_USERNAME;
env.SELFTEST_PASS = env.SCHEDULER_PASSWORD;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
let serverError;
server.on('error', err => { serverError = err; });
function run(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
  });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (serverError || server.exitCode !== null) throw serverError || new Error(serverLog);
    try {
      const res = await fetch(env.SELFTEST_BASE + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (res.ok) { ready = true; break; }
    } catch { /* 等待这个测试进程就绪，不连接现有端口。 */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('隔离实例启动超时');
  await run('scripts/selftest.mjs');
  await run('scripts/p2-selftest.mjs');
  console.log('隔离 API 集成回归通过；未使用在用数据库或共享账号。');
} catch (err) {
  console.error(err.message);
  console.error(serverLog.slice(-4000));
  process.exitCode = 1;
} finally {
  if (server.exitCode === null && !serverError) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timer);
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
