import { NextRequest } from 'next/server';
import { asString, ok, readJson, requireUser, route } from '@/lib/api';
import { BACKUP_DIR, backupKeepCount, createBackup, listBackups, pruneBackups, restoreBackup } from '@/lib/backup';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  await requireUser();
  return ok({ dir: BACKUP_DIR, keep: backupKeepCount(), items: listBackups() });
});

/** 立即备份 */
export const POST = route(async () => {
  await requireUser();
  const item = createBackup('manual');
  const removed = pruneBackups(backupKeepCount());
  return ok({ item, removed, keep: backupKeepCount(), dir: BACKUP_DIR, items: listBackups() });
});

/** 用某一份备份还原当前库。还原前会自动再存一份。 */
export const PUT = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const name = asString(body.name, '备份文件', { required: true, max: 80 });
  const result = restoreBackup(name);
  return ok({ ...result, items: listBackups() });
});
