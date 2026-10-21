import fs from 'node:fs';
import crypto from 'node:crypto';

if (fs.existsSync('.env')) {
  console.log('.env 已存在，保持原样。账号请在本机 .env 查看；空配置需要手动填写。');
} else {
  const username = 'manager-' + crypto.randomBytes(3).toString('hex');
  const password = crypto.randomBytes(18).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync('.env', `SCHEDULER_USERNAME=${username}\nSCHEDULER_PASSWORD=${password}\nJWT_SECRET=${secret}\nSESSION_DAYS=7\n`, { flag: 'wx', mode: 0o600 });
  console.log('已生成本机 .env（不要提交或分享）。\n账号：' + username + '\n密码：' + password);
}
