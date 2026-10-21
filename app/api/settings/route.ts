import { NextRequest } from 'next/server';
import { asString, assert, ok, readJson, requireSensitive, requireUser, route } from '@/lib/api';
import { SK, getAllSettings, setSettings } from '@/lib/settings';
import { regroupWeeks } from '@/lib/scheduler/store';
import { hasSensitivePin, sensitiveHidden, autoLockMinutes } from '@/lib/sensitive';
import { DB_PATH, DATA_DIR, getDb, tableCount } from '@/lib/db';
import { BACKUP_DIR } from '@/lib/backup';

export const dynamic = 'force-dynamic';

/** 敏感项：hash / salt 永不返回给前端 */
const SECRET_KEYS = [SK.sensitivePinHash, SK.sensitivePinSalt];
const SENSITIVE_KEYS = [SK.sensitiveHidden, SK.sensitiveAutoLock];

/** 排班要求条数（不含保密的不搭班记录） */
function nonSecretRequirementCount(): number {
  try {
    return (getDb().prepare("SELECT COUNT(*) AS c FROM requirements WHERE type <> 'pairing'").get() as { c: number }).c;
  } catch {
    return 0;
  }
}

export const GET = route(async () => {
  await requireUser();
  const all = getAllSettings();
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (SECRET_KEYS.includes(k as (typeof SECRET_KEYS)[number])) continue;
    safe[k] = v;
  }
  return ok({
    settings: safe,
    meta: {
      hasSensitivePin: hasSensitivePin(),
      sensitiveHidden: sensitiveHidden(),
      autoLockMinutes: autoLockMinutes(),
      dbPath: DB_PATH,
      dataDir: DATA_DIR,
      backupDir: BACKUP_DIR,
      counts: {
        employees: tableCount('employees'),
        shifts: tableCount('shift_templates'),
        holidays: tableCount('holidays'),
        // 不含「不搭班」：这是保密约束，未解锁时连条数都不能给（否则能反推保密记录有几条）
        requirements: nonSecretRequirementCount(),
        schedules: tableCount('schedules'),
        entries: tableCount('schedule_entries'),
      },
    },
  });
});

export const PUT = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const patch: Record<string, string> = {};

  if (body[SK.shopName] !== undefined) {
    patch[SK.shopName] = asString(body[SK.shopName], '门店名称', { required: true, max: 30 });
  }
  if (body[SK.backupKeep] !== undefined) {
    const n = Number(body[SK.backupKeep]);
    assert(Number.isInteger(n) && n >= 1 && n <= 365, '备份保留份数需为 1-365 之间的整数');
    patch[SK.backupKeep] = String(n);
  }
  if (body[SK.dailyBackup] !== undefined) {
    patch[SK.dailyBackup] = body[SK.dailyBackup] ? '1' : '0';
  }
  if (body[SK.schedulerAllowMiddleEarly] !== undefined) {
    patch[SK.schedulerAllowMiddleEarly] = body[SK.schedulerAllowMiddleEarly] ? '1' : '0';
  }
  // 需求②：早班必须 ≥1 名女性（硬约束开关，默认开）
  if (body[SK.schedulerRequireFemaleEarly] !== undefined) {
    patch[SK.schedulerRequireFemaleEarly] = body[SK.schedulerRequireFemaleEarly] ? '1' : '0';
  }
  // P2：每人每月最少休息天数（2-10 整数），引擎的月休硬约束与容量体检都用它
  if (body[SK.schedulerMinRestDays] !== undefined) {
    const n = Number(body[SK.schedulerMinRestDays]);
    assert(Number.isInteger(n) && n >= 2 && n <= 10, '每人每月最少休息天数需为 2-10 之间的整数');
    patch[SK.schedulerMinRestDays] = String(n);
  }
  // 店长月休单独一项：0 表示这个月可以不休，不跟员工天数绑在一起
  if (body[SK.schedulerManagerRestDays] !== undefined) {
    const n = Number(body[SK.schedulerManagerRestDays]);
    assert(Number.isInteger(n) && n >= 0 && n <= 10, '店长每月最少休息天数需为 0-10 之间的整数');
    patch[SK.schedulerManagerRestDays] = String(n);
  }
  // 店长夜班限额：以早中班为主，0 表示不上夜班
  if (body[SK.schedulerManagerMaxNights] !== undefined) {
    const n = Number(body[SK.schedulerManagerMaxNights]);
    assert(Number.isInteger(n) && n >= 0 && n <= 10, '店长每月最多夜班次数需为 0-10 之间的整数');
    patch[SK.schedulerManagerMaxNights] = String(n);
  }
  // 一周起始日：1=周一 … 7=周日。改周期后现有班表按新周期重新归组（谁上哪天不变）
  if (body[SK.schedulerWeekStart] !== undefined) {
    const n = Number(body[SK.schedulerWeekStart]);
    assert(Number.isInteger(n) && n >= 1 && n <= 7, '一周起始日需为周一~周日');
    patch[SK.schedulerWeekStart] = String(n);
  }
  // 连续休息上限：0-14 天，0 = 不压连休（周排班页的标红也跟着这个值走）
  if (body[SK.schedulerMaxRestStreak] !== undefined) {
    const n = Number(body[SK.schedulerMaxRestStreak]);
    assert(Number.isInteger(n) && n >= 0 && n <= 14, '连续休息上限需为 0-14 之间的整数（0 = 不限制）');
    patch[SK.schedulerMaxRestStreak] = String(n);
  }
  // 压连休补位排到哪个班（开关放在周排班页，但值是全局设置）
  if (body[SK.schedulerReliefShift] !== undefined) {
    const value = asString(body[SK.schedulerReliefShift], '补位班次');
    assert(value === 'early' || value === 'middle' || value === 'night', '补位班次只能是 早班 / 中班 / 晚班');
    patch[SK.schedulerReliefShift] = value;
  }
  for (const key of ['night', 'early', 'middle', 'rest', 'field', 'streak', 'changes', 'female']) {
    const setting = 'scheduler_weight_' + key;
    if (body[setting] !== undefined) {
      const n = Number(body[setting]);
      assert(Number.isFinite(n) && n >= 0 && n <= 100, '权重需为 0-100 之间的数字');
      patch[setting] = String(n);
    }
  }

  const touchingSensitive =
    body[SK.sensitiveHidden] !== undefined || body[SK.sensitiveAutoLock] !== undefined;
  if (touchingSensitive) {
    // 改动敏感区配置必须先解锁，避免路过的人随手关掉隐蔽模式
    await requireSensitive();
    if (body[SK.sensitiveHidden] !== undefined) {
      patch[SK.sensitiveHidden] = body[SK.sensitiveHidden] ? '1' : '0';
    }
    if (body[SK.sensitiveAutoLock] !== undefined) {
      const n = Number(body[SK.sensitiveAutoLock]);
      assert(Number.isInteger(n) && n >= 1 && n <= 240, '自动上锁时间需为 1-240 分钟');
      patch[SK.sensitiveAutoLock] = String(n);
    }
  }

  assert(Object.keys(patch).length > 0, '没有需要保存的修改');
  setSettings(patch);
  if (patch[SK.schedulerWeekStart] !== undefined) regroupWeeks();
  return ok({ saved: Object.keys(patch) });
});
