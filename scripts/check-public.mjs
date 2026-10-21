/** 扫描发布目录，报告位置而不回显疑似凭据。不是无漏洞证明。 */
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const ignored = new Set(['node_modules', '.next', '.git', 'out', 'dist']);
const problems = [];
let files = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), rel = path.relative(root, p);
    if (e.isSymbolicLink()) { problems.push(rel + ': 不应分发符号链接'); continue; }
    if (e.isDirectory()) {
      if (ignored.has(e.name)) continue;
      if (dir === root && ['data', 'backup', '.playwright-mcp'].includes(e.name)) { problems.push(rel + ': 运行期或私人目录'); continue; }
      walk(p); continue;
    }
    if (e.name === 'tsconfig.tsbuildinfo' || e.name === 'next-env.d.ts') continue;
    files++;
    if ((e.name.startsWith('.env') && e.name !== '.env.example') || /\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$|\.log$/.test(e.name)) {
      problems.push(rel + ': 运行数据或本机配置'); continue;
    }
    if (/\.(?:png|jpg|jpeg|woff2?|ico)$/.test(e.name)) continue;
    const s = fs.readFileSync(p, 'utf8');
    // 检测真实机器绝对路径与常见长格式密钥；规则自身分段拼写，避免自匹配。
    const patterns = [new RegExp('/' + 'Users/[^/\\s]+/'), new RegExp('[A-Z]:\\\\' + 'Users\\\\', 'i'), /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9]{30,}/, /sk-[A-Za-z0-9_-]{32,}/];
    if (patterns.some(r => r.test(s))) problems.push(rel + ': 私人路径或疑似凭据');
    if (p.endsWith('.env.example') && /^(SCHEDULER_USERNAME|SCHEDULER_PASSWORD|JWT_SECRET)=.+/m.test(s)) problems.push(rel + ': 示例含非空账号或密钥');
  }
}
walk(root);
console.log(`检查 ${files} 个文件；发现 ${problems.length} 项。`);
for (const x of problems) console.error(x);
if (problems.length) process.exitCode = 1;
