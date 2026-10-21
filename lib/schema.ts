/**
 * 数据库结构（SQLite）
 * 建表语句全部 IF NOT EXISTS，可重复执行 —— 应用每次启动都会跑一遍，等价于自动迁移。
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

-- 员工表
CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  tags        TEXT    NOT NULL DEFAULT '[]',            -- JSON 数组，如 ["内场"]
  status      TEXT    NOT NULL DEFAULT 'active'         -- active 在职 / leave 请假中 / resigned 离职
              CHECK (status IN ('active','leave','resigned')),
  hire_date   TEXT,                                     -- 入职日期 YYYY-MM-DD
  leave_date  TEXT,                                     -- 离职日期 YYYY-MM-DD
  gender      TEXT    NOT NULL DEFAULT ''               -- 男 / 女 / 空=不填（不填不参与早班女性规则计数）
              CHECK (gender IN ('', '男', '女')),
  seniority   TEXT    NOT NULL DEFAULT '老人'            -- 老人 / 新人（新人必须与可带教者同班）
              CHECK (seniority IN ('老人', '新人')),
  can_teach   INTEGER NOT NULL DEFAULT 1,               -- 1=可带教（默认老人可带教，可手动关）
  position    TEXT    NOT NULL DEFAULT '员工'            -- 店长 / 员工（店长默认可带教，可多个也可 0 个）
              CHECK (position IN ('店长', '员工')),
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);

-- 班次模板表（预置 早/中/晚 三条，人数按日期类型分三档）
CREATE TABLE IF NOT EXISTS shift_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,               -- early / middle / night
  name           TEXT    NOT NULL,
  start_time     TEXT    NOT NULL,                      -- HH:mm
  end_time       TEXT    NOT NULL,                      -- HH:mm
  cross_day      INTEGER NOT NULL DEFAULT 0,            -- 1=跨天（结束时间在次日）
  weekday_count  INTEGER NOT NULL DEFAULT 1,            -- 平日人数
  weekend_count  INTEGER NOT NULL DEFAULT 1,            -- 周末人数
  holiday_count  INTEGER NOT NULL DEFAULT 1,            -- 法定节假日人数
  enabled        INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 节假日日历：kind=holiday 法定节假日（忙日），kind=workday 调休上班日（平日）
CREATE TABLE IF NOT EXISTS holidays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL UNIQUE,                  -- YYYY-MM-DD
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'holiday' CHECK (kind IN ('holiday','workday')),
  year        INTEGER NOT NULL,
  is_preset   INTEGER NOT NULL DEFAULT 0,               -- 1=系统预置
  estimated   INTEGER NOT NULL DEFAULT 0,               -- 1=预估（官方通知尚未发布）
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_holidays_year ON holidays(year);

-- 周排班表（P1 使用，P0 只建表）
CREATE TABLE IF NOT EXISTS schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start   TEXT    NOT NULL UNIQUE,                 -- 周一 YYYY-MM-DD
  week_end     TEXT    NOT NULL,                        -- 周日 YYYY-MM-DD
  status       TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked')),
  note         TEXT,
  generated_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 班次明细表（P1 使用，P0 只建表；已为 P1 预留：日期/班次/员工/状态）
-- 约定：休息日记录 shift_code = 'rest' 且 shift_id 为空
CREATE TABLE IF NOT EXISTS schedule_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  work_date   TEXT    NOT NULL,                         -- 该条记录所属日期 YYYY-MM-DD
  shift_id    INTEGER REFERENCES shift_templates(id) ON DELETE SET NULL,
  shift_code  TEXT    NOT NULL DEFAULT 'rest',          -- early/middle/night/rest
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status      TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked')),
  source      TEXT    NOT NULL DEFAULT 'auto'  CHECK (source IN ('auto','manual','swap')),
  is_rest     INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (work_date, shift_code, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_schedule ON schedule_entries(schedule_id);
CREATE INDEX IF NOT EXISTS idx_entries_date     ON schedule_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_entries_employee ON schedule_entries(employee_id);

-- 排班要求表（请假 / 不搭班 / 避班 / 临时加派，单表 + type 字段）
CREATE TABLE IF NOT EXISTS requirements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL CHECK (type IN ('leave','pairing','avoid','extra')),
  employee_id   INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  employee_id_2 INTEGER REFERENCES employees(id) ON DELETE CASCADE,  -- 仅 pairing 使用
  leave_type    TEXT,                                   -- 事假 / 病假 / 月休（仅 leave）
  shift_codes   TEXT    NOT NULL DEFAULT '[]',          -- JSON 数组（avoid / extra）
  date_start    TEXT,                                   -- 开始日期；空=不限
  date_end      TEXT,                                   -- 结束日期；空=不限
  override_count INTEGER,                               -- 加派人数（仅 extra）
  long_term     INTEGER NOT NULL DEFAULT 0,             -- 1=长期有效
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_req_type     ON requirements(type);
CREATE INDEX IF NOT EXISTS idx_req_employee ON requirements(employee_id);

-- 键值配置表
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;
