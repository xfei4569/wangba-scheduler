'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Divider,
  Empty,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  LeftOutlined,
  LockOutlined,
  ReloadOutlined,
  RightOutlined,
  ThunderboltOutlined,
  UnlockOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api, type ApiFailure } from '@/lib/client';
import dayjs from 'dayjs';
import BackupReminder from '@/components/BackupReminder';
import { exportPeopleMatrixExcel, LEAVE_CELL, PENDING_CELL, REST_CELL, SHIFT_CELL_CN } from '@/lib/excel';
import { addDays, todayStr, weekdayCn } from '@/lib/date';
import { isFemale, isMentor, isNewbie, type Employee, type ShiftTemplate } from '@/lib/types';

interface Entry { id: number; work_date: string; shift_code: string; employee_id: number; employee_name: string | null; status: string; source: string; note: string | null }
interface Demand { date: string; code: string; name: string; start_time: string; demand: number; base: number; override: boolean }
interface RuleIssue { kind: 'gender' | 'mentor'; date: string; shift: string; text: string; suggestion: string }
interface WeekPerson { employeeId: number; name: string; workDays: number; restDays: number; nights: number; restDates: string[]; longRest?: string[]; monthRest?: number; monthlyRestGap: number }
interface Report {
  demand: number; assigned: number; coverage: number; score: number;
  people: { employeeId: number; name: string; early: number; middle: number; night: number; rest: number; month: string }[];
  warnings: string[]; week: WeekPerson[]; ruleIssues: RuleIssue[];
  /** 店长月休提示：服务端按「店长每月最少休息天数」算出，0 = 不设下限时恒为 null */
  managerRestNotice?: string | null;
  managerRestDays?: number;
  /** 尽力排：引擎动不了的残留问题（服务端已按口令解锁状态脱敏；未解锁时涉密条目只有聚合文案） */
  residuals?: string[];
}
interface Diagnosis {
  capacity: { demand: number; available: number; byMonth: { month: string; demand: number; available: number }[] };
  missing: { date: string; shift: string; missing: number; excluded: { employeeId: number; name: string; reasons: string[] }[]; suggestion: string }[];
  conflicts: string[];
  suggestions: string[];
  over?: { date: string; shift: string; assigned: number; count: number }[];
  ruleIssues?: RuleIssue[];
}
interface WeekData {
  weekStart: string; weekEnd: string;
  schedule: { id: number; status: 'draft' | 'locked' } | null;
  entries: Entry[]; report: Report | null; capacity: Diagnosis['capacity'] | null;
  demand: Demand[]; restRequirement: number; frozenSlots: string[];
  /** 店长月休下限（设置值，0 = 不设下限）；界面提醒以它为准 */
  managerRestRequirement?: number;
  /** 单日锁定：这一周里被整天冻结的日期 */
  lockedDays?: string[];
  /** 店长本周不休息（这一周的开关） */
  managerNoRest?: boolean;
  /** 压连休补位排到哪个班 */
  reliefShift?: 'early' | 'middle' | 'night';
  /** 实时体检：每个班次当前违反的约束（修完即清，不留历史快照） */
  issues?: Record<number, string[]>;
}

const LABEL: Record<string, string> = { early: '早班', middle: '中班', night: '晚班' };
/** 班次列的淡色底：一眼分清早/中/晚三列（参考主流排班软件的班次配色） */
const SHIFT_BG: Record<string, string> = { early: '#e6f4ff', middle: '#fffbe6', night: '#f9f0ff' };

export default function SchedulePage() {
  const { message, modal } = AntdApp.useApp();
  const [weekStart, setWeekStart] = useState(() => {
    // 记住上次选的起始日：离开页面再回来还是这一天，不用每次重选
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('wangba-week-start') : null;
    return saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) ? saved : todayStr();
  });
  const [data, setData] = useState<WeekData | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<ShiftTemplate[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [lockIssues, setLockIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState<{ date: string; code: string; name: string; demand: number; base: number; override: boolean } | null>(null);
  const [staffCount, setStaffCount] = useState(1);
  const [staffScope, setStaffScope] = useState<'day' | 'same-kind'>('day');
  const [staffPeople, setStaffPeople] = useState<number[]>([]);
  const [exporting, setExporting] = useState(false);
  const [planNo, setPlanNo] = useState<number | null>(null);
  /** 拖拽换班：拖住人名挪到另一个人身上=互换，挪到格子里=换到这个班 */
  const [dragEntry, setDragEntry] = useState<Entry | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  // 月表「临时 N 人」等入口可带 ?week=YYYY-MM-DD 直接跳到对应周
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('week');
    if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) setWeekStart(q);
  }, []);

  /** 请求序号：慢的旧响应不得把新周覆盖回去（?week= 跳周时踩过的竞态） */
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const [week, people, templates] = await Promise.all([
        api.get<WeekData>('/api/schedule/generate?week_start=' + weekStart),
        api.get<{ items: Employee[] }>('/api/employees'),
        api.get<{ items: ShiftTemplate[] }>('/api/shifts'),
      ]);
      if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃这份过期数据
      setData(week);
      if (week.weekStart !== weekStart) setWeekStart(week.weekStart); // 按「一周起始日」对齐后的真起点
      setEmployees(people.items);
      setShifts(templates.items.filter((s) => s.enabled === 1));
      setLockIssues([]);
      setDiagnosis(null); // 数据一刷新，旧的「排不下诊断」就是过期快照，清掉
    } catch (err) { if (seq === reqSeq.current) message.error(err instanceof Error ? err.message : '加载失败'); }
    finally { if (seq === reqSeq.current) setLoading(false); }
  }, [weekStart, message]);

  useEffect(() => { load(); }, [load]);

  /**
   * 高级设置口令可能在我们没操作的时候失效（自动上锁 / 在别处点了「立即上锁」/ 改了口令）。
   * 这个页面在解锁期间取回的体检报告与红字里可能带着保密明细，服务端只在「请求那一刻」脱敏，
   * 所以必须盯着解锁状态：一旦由「已解锁」变成「已上锁」，立刻把页面数据重新拉一遍（服务端会重新脱敏）。
   */
  const unlockedRef = useRef<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const status = await api.get<{ unlocked: boolean }>('/api/sensitive');
        if (!alive) return;
        const wasUnlocked = unlockedRef.current === true;
        unlockedRef.current = status.unlocked;
        if (wasUnlocked && !status.unlocked) {
          setDiagnosis(null);
          setLockIssues([]);
          await load();
        }
      } catch {
        /* 拿不到状态时不动作：宁可保持现状，也不要因为一次请求失败把页面清空 */
      }
    };
    check();
    const timer = window.setInterval(check, 60000);
    const onFocus = () => { void check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load]);
  useEffect(() => { window.localStorage.setItem('wangba-week-start', weekStart); }, [weekStart]);

  const byId = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const perform = async (path: string, body: Record<string, unknown>, week = weekStart) => {
    setBusy(true);
    try {
      const result = await api.post<{ ok: boolean; diagnosis?: Diagnosis; seed?: number; report?: Report }>(path, { week_start: week, ...body });
      if (!result.ok) {
        setDiagnosis(result.diagnosis || null);
        setPlanNo(null);
        message.warning((week === weekStart ? '本周' : week + ' 这一周') + '排不下，请查看诊断');
      } else {
        setDiagnosis(null);
        // 尽力排：只要有可行解就落库，动不了的存量冲突只当提醒（文案服务端已脱敏）
        const residualCount = result.report?.residuals?.length ?? 0;
        const tail = residualCount ? '，有 ' + residualCount + ' 处提醒，请看体检报告' : '';
        // 需求①：把本次随机方案号显示出来，用户能确认「确实换了方案」
        if (typeof result.seed === 'number') {
          setPlanNo(result.seed);
          message.success('已重排（方案号 ' + result.seed + '）' + tail);
        } else {
          message.success('排班已更新' + tail);
        }
        // 目标周不是当前显示的周时，setWeekStart 会触发 load()，这里不要重复拉
        if (week === weekStart) await load();
      }
    } catch (err) { message.error(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };

  /** 一键排下周：跳到下一周并直接生成（起始日自选，所以「下周」= 当前窗口 +7 天） */
  const scheduleNextWeek = () => {
    const target = addDays(weekStart, 7);
    setDiagnosis(null);
    setPlanNo(null);
    setWeekStart(target);
    void perform('/api/schedule/generate', {}, target);
  };

  const changePerson = async (entry: Entry, employeeId: number) => {
    if (employeeId === entry.employee_id) return;
    setBusy(true);
    try {
      const path = '/api/schedule/entries/' + entry.id;
      const check = await api.patch<{ valid: boolean; reasons: string[]; notices?: string[] }>(path, { employee_id: employeeId, dryRun: true });
      if (!check.valid) {
        Modal.confirm({
          title: '此换人违反排班约束',
          content: <div style={{ color: '#cf1322' }}>{[...check.reasons, ...(check.notices || [])].join('、')}。仍要强制生效吗？</div>,
          okText: '强制生效', okButtonProps: { danger: true }, cancelText: '取消',
          onOk: async () => { await api.patch(path, { employee_id: employeeId, force: true }); message.warning('已强制换人'); await load(); },
        });
      } else {
        await api.patch(path, { employee_id: employeeId });
        // 「这个班已经开始」只是提示（问题①）：已开始 / 过去的日子也能手动改回来
        if (check.notices?.length) message.warning(check.notices.join('；'));
        else message.success('换人成功');
        await load();
      }
    } catch (err) { message.error(err instanceof Error ? err.message : '换人失败'); }
    finally { setBusy(false); }
  };

  /** 撤下：把人从这个班移除（该班显示缺员，重算自动补位） */
  const removePerson = (entry: Entry) => {
    Modal.confirm({
      title: '撤下这个人？',
      content: `把「${entry.employee_name || '该员工'}」从这个班撤下。撤下后该班会显示缺员，重算时自动补人。`,
      okText: '撤下', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        setBusy(true);
        try { await api.del('/api/schedule/entries/' + entry.id); message.success('已撤下，重算可自动补人'); await load(); }
        catch (err) { message.error(err instanceof Error ? err.message : '撤下失败'); }
        finally { setBusy(false); }
      },
    });
  };

  /** 拖拽操作的共用流程：先试查，有冲突弹「强制生效」确认 */
  const runDragOp = async (
    title: string, success: string,
    dryRun: () => Promise<{ valid: boolean; reasons: string[]; notices?: string[] }>,
    run: (force: boolean) => Promise<unknown>,
  ) => {
    setBusy(true);
    try {
      const check = await dryRun();
      if (!check.valid) {
        Modal.confirm({
          title, content: <div style={{ color: '#cf1322' }}>{[...check.reasons, ...(check.notices || [])].join('、')}。仍要强制生效吗？</div>,
          okText: '强制生效', okButtonProps: { danger: true }, cancelText: '取消',
          onOk: async () => { await run(true); message.warning('已强制生效'); await load(); },
        });
      } else {
        await run(false);
        // 已开始的班只提示不拦（问题①）
        if (check.notices?.length) message.warning(check.notices.join('；'));
        else message.success(success);
        await load();
      }
    } catch (err) { message.error(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };

  /** 拖到人身上：两人互换班次 */
  const swapEntries = (a: Entry, b: Entry) => {
    if (a.id === b.id) return;
    if (isDayLocked(a.work_date) || isDayLocked(b.work_date)) { message.warning('该日已锁定，先解锁'); return; }
    if (a.work_date === b.work_date && a.shift_code === b.shift_code) { message.info('同一个班的两个人不用互换'); return; }
    const path = '/api/schedule/entries/' + a.id;
    runDragOp('互换违反排班约束', '已互换两人班次',
      () => api.patch(path, { swap_with: b.id, dryRun: true }),
      (force) => api.patch(path, { swap_with: b.id, force }));
  };

  /** 拖到格子里：把人挪到这个班（原班留空） */
  const moveEntry = (e: Entry, date: string, code: string) => {
    if (isDayLocked(e.work_date) || isDayLocked(date)) { message.warning('该日已锁定，先解锁'); return; }
    if (e.work_date === date && e.shift_code === code) return;
    const path = '/api/schedule/entries/' + e.id;
    runDragOp('挪班违反排班约束', '已挪到这个班',
      () => api.patch(path, { work_date: date, shift_code: code, dryRun: true }),
      (force) => api.patch(path, { work_date: date, shift_code: code, force }));
  };

  /** 单日锁定：只冻结这一天的人员安排，别的天照旧可改（问题③） */
  const toggleDayLock = async (date: string) => {
    const next = !isDayLocked(date);
    setBusy(true);
    try {
      await api.post('/api/schedule/day-lock', { date, locked: next });
      message.success(next ? date + ' 已锁定：这一天的人员安排已冻结' : date + ' 已解锁，可以改了');
      await load();
    } catch (err) { message.error(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };

  const toggleLock = async () => {
    setBusy(true);
    setLockIssues([]);
    try {
      const locked = data?.schedule?.status !== 'locked';
      await api.post('/api/schedule/lock', { week_start: weekStart, locked });
      message.success(locked ? '本周已锁定' : '本周已解锁');
      await load();
    } catch (err) {
      const issues = (err as ApiFailure).issues;
      if (issues?.length) setLockIssues(issues);
      message.error(err instanceof Error ? err.message : '操作失败');
    }
    finally { setBusy(false); }
  };

  const clearWeek = () => {
    modal.confirm({
      title: '删除这 7 天的排班？',
      content: weekStart + ' 到 ' + addDays(weekStart, 6) + ' 的班会全部删掉，包括今天已经开始的。已锁定的要先解锁。删完可以重新排。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await api.post<{ removed: number }>('/api/schedule/clear', { scope: 'week', from: weekStart });
        message.success('已删除 ' + result.removed + ' 条班次');
        await load();
      },
    });
  };

  const clearDay = (date: string) => {
    if (isDayLocked(date)) { message.warning('该日已锁定，先解锁'); return; }
    modal.confirm({
      title: '删除 ' + date + ' 的排班？',
      content: '这一天的班会全部删掉，包括已经开始的。已锁定的要先解锁。删完可以重新排，不影响别的天。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await api.post<{ removed: number }>('/api/schedule/clear', { scope: 'day', from: date });
        message.success('已删除 ' + result.removed + ' 条班次');
        await load();
      },
    });
  };

  /** 店长本周不休息：只影响这一周，别的周不受影响 */
  const toggleManagerNoRest = async () => {
    const next = !data?.managerNoRest;
    setBusy(true);
    try {
      await api.post('/api/schedule/manager', { week_start: weekStart, no_rest: next });
      message.success(next ? '店长牛马启动器已开启，生成时会把店长排满整周' : '店长牛马启动器已关闭，本周恢复给店长排休息');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '设置失败');
    } finally {
      setBusy(false);
    }
  };

  /** 压连休补位排到哪个班（全局设置，但开关放在周排班页，方便排班时调） */
  const changeReliefShift = async (code: string) => {
    try {
      await api.put('/api/settings', { scheduler_relief_shift: code });
      setData((d) => (d ? { ...d, reliefShift: code as 'early' | 'middle' | 'night' } : d));
      message.success('补位排到' + (LABEL[code as 'early'] || code));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '设置失败');
    }
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const locked = data?.schedule?.status === 'locked';
  const report = data?.report;
  const peopleOptions = employees.filter((e) => e.status === 'active').map((e) => ({ value: e.id, label: e.name }));
  // B6：Excel 的「待排」口径与月表 / 周视图一致 —— 只认「看得到人」的条目（employee_id 非空的引用行不算有人）
  const scheduledDates = useMemo(() => new Set((data?.entries || []).filter((entry) => entry.employee_id).map((entry) => entry.work_date)), [data]);
  /** 「已经开始」只作提示：手动换人 / 挪班 / 撤下 / 加人照常可用（问题①） */
  const started = (date: string, code: string) => (data?.frozenSlots || []).includes(date + '|' + code);
  /** 单日锁定：这一天的人员安排冻结（问题③） */
  const dayLockedDates = useMemo(() => new Set(data?.lockedDays || []), [data]);
  const isDayLocked = (date: string) => dayLockedDates.has(date);
  // 公平口径与引擎一致：店长不参与员工的出勤 / 晚班拉平，也不算「休息差」「最少休息」
  const staffRows = (report?.people || []).filter((p) => byId.get(p.employeeId)?.position !== '店长');
  const spread = (key: 'night' | 'rest') => staffRows.length ? Math.max(0, ...[...new Set(staffRows.map((p) => p.month))].map((month) => {
    const rows = staffRows.filter((p) => p.month === month);
    return Math.max(...rows.map((p) => p[key])) - Math.min(...rows.map((p) => p[key]));
  })) : 0;

  const demandOf = (date: string, code: string): Demand => data?.demand?.find((d) => d.date === date && d.code === code)
    || { date, code, name: LABEL[code] || code, start_time: '', demand: 0, base: 0, override: false };

  /** 某人在某班的角色徽章：新（新人）/ 带（本班正在带新人）/ 店长 */
  const badgesOf = (employeeId: number, date: string, code: string) => {
    const e = byId.get(employeeId);
    if (!e) return [] as string[];
    const out: string[] = [];
    if (e.position === '店长') out.push('店长');
    const newbie = isNewbie(e);
    if (newbie) out.push('新');
    if (isMentor(e) && !newbie) {
      const peers = (data?.entries || []).filter((x) => x.work_date === date && x.shift_code === code && x.employee_id !== employeeId);
      if (peers.some((x) => { const pe = byId.get(x.employee_id); return Boolean(pe && isNewbie(pe)); })) out.push('带');
    }
    return out;
  };

  const openStaff = (date: string, code: string) => {
    const current = demandOf(date, code);
    if (locked) { message.warning('本周已锁定，请先解锁再改人数'); return; }
    if (isDayLocked(date)) { message.warning('该日已锁定，先解锁'); return; }
    setStaff({ date, code, name: current.name, demand: current.demand, base: current.base, override: current.override });
    setStaffCount(current.demand);
    setStaffScope('day');
    setStaffPeople([]);
  };

  const saveStaff = async (force = false) => {
    if (!staff) return;
    setBusy(true);
    try {
      const pinned = staffScope === 'day' ? staffPeople : [];
      const payload = { date: staff.date, shift_code: staff.code, count: staffCount, scope: staffScope, employee_ids: pinned, force };
      if (pinned.length && !force) {
        const check = await api.post<{ conflicts: { name: string; reasons: string[] }[]; secret_notice?: string | null; notices?: string[] }>('/api/schedule/staffing', { ...payload, dry_run: true });
        // 涉密（不搭班）不挂到人身上：未解锁时只有一句聚合提示，解锁后才有具体原因
        const lines = [...check.conflicts.map((c) => c.name + '：' + c.reasons.join('、')), ...(check.secret_notice ? [check.secret_notice] : [])];
        const hints = check.notices || [];
        if (lines.length) {
          setBusy(false);
          Modal.confirm({
            title: '点名的人违反排班约束',
            content: <div style={{ color: '#cf1322' }}>{[...lines, ...hints].join('；')}。仍要强制生效吗？</div>,
            okText: '强制生效', okButtonProps: { danger: true }, cancelText: '取消',
            onOk: () => saveStaff(true),
          });
          return;
        }
        // 「这个班已经开始」只提示不拦（问题①）：加人照常生效
        if (hints.length) message.warning(hints.join('；'));
      }
      const result = await api.post<{ changed: number; stale_weeks: string[]; skipped_locked_weeks?: string[]; skipped_locked_days?: string[]; pinned?: { name: string }[]; notices?: string[] }>('/api/schedule/staffing', payload);
      const target = staff;
      setStaff(null);
      const skipped = (result.skipped_locked_weeks?.length ? '；已跳过已锁定周 ' + result.skipped_locked_weeks.join('、') : '')
        + (result.skipped_locked_days?.length ? '；已跳过已锁定日 ' + result.skipped_locked_days.join('、') : '');
      const pinnedNames = (result.pinned || []).map((p) => p.name);
      if (result.notices?.length) message.warning(result.notices.join('；'));
      message.success(
        (staffScope === 'same-kind'
          ? '已把本月同类日（' + result.changed + ' 天）的 ' + target.name + ' 改为 ' + staffCount + ' 人'
          : '已把 ' + target.date + ' 的 ' + target.name + ' 改为 ' + staffCount + ' 人')
        + (pinnedNames.length ? '；已点名 ' + pinnedNames.join('、') + ' 进班' : '') + skipped
      );
      await load();
      const otherWeeks = result.stale_weeks.filter((week) => week !== weekStart);
      if (result.stale_weeks.includes(weekStart)) {
        Modal.confirm({
          title: '人数已变',
          content: <>本周已生成的班表需要重算或手动补人。重算会保留已过去和手工调整的班次。{otherWeeks.length > 0 && <p>另外 {otherWeeks.join('、')} 的班表也受影响，请分别打开检查。</p>}</>,
          okText: '重算未来班次',
          cancelText: '稍后手动处理',
          onOk: () => perform('/api/schedule/regenerate', {}),
        });
      } else if (otherWeeks.length > 0) {
        Modal.info({ title: '其他周班表需要检查', content: `${otherWeeks.join('、')} 已生成过班表；请分别打开并重算或手动调整。` });
      }
    } catch (err) { message.error(err instanceof Error ? err.message : '改人数失败'); }
    finally { setBusy(false); }
  };

  const entryOf = (date: string, code: string) => (data?.entries || []).filter((e) => e.work_date === date && e.shift_code === code);

  /**
   * 空位直接选人补上：走后端的「点名加派」（employee_ids），冲突先试查、可选强制，
   * 成功立即落库，不必等「重算未来班次」。撤下人、改多人数之后都能用它当场补位。
   */
  const fillSlot = async (date: string, code: string, employeeId: number, force = false) => {
    const need = demandOf(date, code);
    const payload = { date, shift_code: code, count: need.demand, scope: 'day' as const, employee_ids: [employeeId], force };
    setBusy(true);
    try {
      if (!force) {
        const check = await api.post<{ conflicts: { name: string; reasons: string[] }[]; secret_notice?: string | null; notices?: string[] }>('/api/schedule/staffing', { ...payload, dry_run: true });
        const lines = [...check.conflicts.map((c) => c.name + '：' + c.reasons.join('、')), ...(check.secret_notice ? [check.secret_notice] : [])];
        const hints = check.notices || [];
        if (lines.length) {
          setBusy(false);
          Modal.confirm({
            title: '这个人进这个班会违反排班约束',
            content: <div style={{ color: '#cf1322' }}>{[...lines, ...hints].join('；')}。仍要强制排进去吗？</div>,
            okText: '强制生效', okButtonProps: { danger: true }, cancelText: '取消',
            onOk: () => fillSlot(date, code, employeeId, true),
          });
          return;
        }
        // 已开始的班只提示不拦（问题①）
        if (hints.length) message.warning(hints.join('；'));
      }
      await api.post('/api/schedule/staffing', payload);
      message.success('已补上 ' + (byId.get(employeeId)?.name || '这个人'));
      await load();
    } catch (err) { message.error(err instanceof Error ? err.message : '补人失败'); }
    finally { setBusy(false); }
  };

  /** 空位下拉的候选：在职员工里去掉已经在这个班的人 */
  const gapOptions = (date: string, code: string) => {
    const taken = new Set(entryOf(date, code).map((e) => e.employee_id));
    return peopleOptions.filter((o) => !taken.has(o.value));
  };

  /** 导出排班表 Excel：一人一行、列是日期、格子写白班/中班/夜班/休/请假、颜色按人（店长发来的截图样式） */
  const exportWeek = async () => {
    setExporting(true);
    try {
      const weekEnd = addDays(weekStart, 6);
      // 登记的请假：当天没班次时写「请假」而不是「休」
      const reqs = await api.get<{ items: { employee_id: number | null; date_start: string | null; date_end: string | null }[] }>('/api/requirements?type=leave');
      const leaveOn = (employeeId: number, date: string) => reqs.items.some((r) =>
        r.employee_id === employeeId && Boolean(r.date_start) && date >= (r.date_start || '') && date <= (r.date_end || r.date_start || ''));
      const people = employees.filter((e) => e.status === 'active').map((e) => ({
        name: e.name + (e.position === '店长' ? '（店长）' : '') + (isNewbie(e) ? '（新人）' : ''),
        cells: days.map((date) => {
          const entry = (data?.entries || []).find((x) => x.work_date === date && x.employee_id === e.id);
          if (entry) return SHIFT_CELL_CN[entry.shift_code] || entry.shift_code;
          if (leaveOn(e.id, date)) return LEAVE_CELL;
          return scheduledDates.has(date) ? REST_CELL : PENDING_CELL;
        }),
      }));
      const displayName = (id: number) => {
        const e = byId.get(id);
        if (!e) return '已删除员工';
        return e.name + (e.position === '店长' ? '（店长）' : '') + (isNewbie(e) ? '（新人）' : '');
      };
      await exportPeopleMatrixExcel({
        title: '排班表 ' + weekStart + ' 至 ' + weekEnd,
        dates: days,
        people,
        // 「按班次」sheet：一天一行，列是各班次
        shiftHeaders: shifts.map((s) => s.name + ' ' + s.start_time),
        shiftCells: days.map((date) => shifts.map((s) => ({
          people: entryOf(date, s.code).map((x) => displayName(x.employee_id)),
          demand: demandOf(date, s.code).demand,
        }))),
        note: locked ? '注：本周已锁定。' : '注：本周尚未锁定，如需发给员工请先在工作台锁定。',
        fileName: '排班表-' + weekStart + '至' + weekEnd + '.xlsx',
      });
      message.success('已导出 排班表-' + weekStart + '至' + weekEnd + '.xlsx');
    } catch (err) { message.error(err instanceof Error ? err.message : '导出失败'); }
    finally { setExporting(false); }
  };

  return (
    <Spin spinning={loading}>
      <div className="page-title">
        <div>
          <h2>周排班工作台</h2>
          <div className="sub">
            {weekStart} 至 {addDays(weekStart, 6)} · 电脑端排班 · 当前月休要求 {data?.restRequirement ?? 4} 天
            {planNo !== null && <span style={{ marginLeft: 8 }}>· 当前方案号 {planNo}</span>}
          </div>
        </div>
        <Space wrap>
          <Button icon={<LeftOutlined />} onClick={() => { setDiagnosis(null); setWeekStart(addDays(weekStart, -7)); }}>上周</Button>
          <Button icon={<RightOutlined />} onClick={() => { setDiagnosis(null); setWeekStart(addDays(weekStart, 7)); }}>下周</Button>
          <Space size={4}>
            <span className="text-muted">从哪天开始排</span>
            <DatePicker value={dayjs(weekStart)} allowClear={false} format="YYYY-MM-DD"
              onChange={(d) => { if (d) { setDiagnosis(null); setWeekStart(d.format('YYYY-MM-DD')); } }} />
          </Space>
          <Space size={4}>
            <span className="text-muted">补位排到</span>
            <Select size="small" style={{ width: 78 }} value={data?.reliefShift || 'early'}
              onChange={changeReliefShift}
              disabled={locked}
              options={[{ value: 'early', label: '早班' }, { value: 'middle', label: '中班' }, { value: 'night', label: '晚班' }]} />
          </Space>
          <Tooltip title={data?.managerNoRest ? '店长牛马已启动：本周把店长排满整周。点一下恢复' : '把店长排满整周，本周不给店长排休息'}>
            <Button icon={<UserOutlined />} disabled={locked} type={data?.managerNoRest ? 'primary' : 'default'}
              onClick={toggleManagerNoRest}>
              店长牛马启动器
            </Button>
          </Tooltip>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} disabled={locked} onClick={() => perform('/api/schedule/generate', {})}>生成本周班表</Button>
          <Tooltip title={'直接生成 ' + addDays(weekStart, 7) + ' 至 ' + addDays(weekStart, 13) + ' 的班表'}>
            <Button icon={<ThunderboltOutlined />} loading={busy} onClick={scheduleNextWeek}>一键排下周</Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} loading={busy} disabled={!data?.schedule || locked} onClick={() => perform('/api/schedule/regenerate', {})}>重算未来班次</Button>
          <Button disabled={!data?.schedule} icon={locked ? <UnlockOutlined /> : <LockOutlined />} onClick={toggleLock}>{locked ? '解锁' : '检查并锁定'}</Button>
          <Button icon={<DownloadOutlined />} loading={exporting} disabled={!data?.schedule} onClick={exportWeek}>导出排班表 Excel</Button>
          <Button danger icon={<DeleteOutlined />} disabled={!data?.schedule || locked} onClick={clearWeek}>删除这 7 天</Button>
        </Space>
      </div>

      <BackupReminder />

      {data?.schedule && <Alert type={locked ? 'info' : 'success'} showIcon style={{ marginBottom: 12 }} message={locked ? '本周已锁定，不能换人或重排' : '当前为草稿，可换人和锁定'} />}
      {lockIssues.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message="锁定前请修正这些班次"
        description={<ul style={{ marginBottom: 0 }}>{lockIssues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>} />}
      {/* 店长月休提醒（问题②）：由服务端按「店长每月最少休息天数」算出，
          0 = 不设下限 → 恒为 null（零提醒）；>0 且低于该值才有这句话 */}
      {report?.managerRestNotice && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={'店长月休低于设置的 ' + (report.managerRestDays ?? 0) + ' 天'}
          description={report.managerRestNotice} />
      )}

      {report && <Card size="small" style={{ marginBottom: 12 }}>
        <Typography.Text>所涉月份容量：需求 {data?.capacity?.demand} / 可用 {data?.capacity?.available} 人次（每人每月月休要求 {data?.restRequirement ?? 4} 天）</Typography.Text>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <Statistic title="覆盖" value={report.assigned} suffix={'/ ' + report.demand + ' 人次'} />
          <Statistic title="晚班次数差（不含店长）" value={spread('night')} suffix="次" valueStyle={{ color: spread('night') > 1 ? '#cf1322' : undefined }} />
          <Statistic title="已安排休息差（不含店长）" value={spread('rest')} suffix="天" valueStyle={{ color: spread('rest') > 2 ? '#cf1322' : undefined }} />
          <Statistic title="最少已安排休息（不含店长）" value={staffRows.length ? Math.min(...staffRows.map((p) => p.rest)) : 0} suffix="天" />
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
          {report.people.map((p) => <span key={p.month + p.employeeId}>{p.month} {p.name}：早{p.early} 中{p.middle} 晚{p.night} 已安排休{p.rest}</span>)}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>这里只统计已生成日期；整月排完并锁定后，到「月度汇总」看完整月休。</Typography.Text>
        {report.warnings.length > 0 && <Typography.Text type="danger">{report.warnings.join('；')}</Typography.Text>}
        {(report.residuals?.length || 0) > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #ffd591' }}>
            <Typography.Text strong style={{ color: '#d46b08' }}>
              需要你看一眼的 {report.residuals!.length} 处
            </Typography.Text>
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {report.residuals!.map((item, i) => (
                <li key={i}><Typography.Text style={{ color: '#d46b08' }}>{item}</Typography.Text></li>
              ))}
            </ul>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              这些是引擎动不了的存量（手工钉的条目 / 已开始的班）：本次已按「尽力排」落库，不改动它们。修好后再重算一次即可清掉。
            </Typography.Text>
          </div>
        )}
      </Card>}

      {report && (
        <Card size="small" title="本周出勤与休息" style={{ marginBottom: 12 }}>
          <Table<WeekPerson>
            rowKey="employeeId"
            size="small"
            pagination={false}
            dataSource={report.week}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '员工', dataIndex: 'name', width: 110, render: (v: string) => <b>{v}</b> },
              { title: '本周出勤', dataIndex: 'workDays', width: 90, align: 'center' as const, render: (v: number) => v + ' 天' },
              { title: '本周休息', dataIndex: 'restDays', width: 90, align: 'center' as const, render: (v: number) => v + ' 天' },
              { title: '本周晚班', dataIndex: 'nights', width: 90, align: 'center' as const, render: (v: number) => v + ' 次' },
              { title: '本月已休', dataIndex: 'monthRest', width: 90, align: 'center' as const,
                render: (v: number | undefined) => (v ?? 0) + ' 天' },
              { title: '距月休目标', dataIndex: 'monthlyRestGap', width: 100, align: 'center' as const,
                render: (v: number) => (v > 0 ? <Tag color="orange">还差 {v} 天</Tag> : <Tag color="green">已达标</Tag>) },
              { title: '本周哪天休息', dataIndex: 'restDates',
                render: (dates: string[], row: WeekPerson) => {
                  if (!dates.length) return <span className="text-muted">无</span>;
                  const over = new Set(row.longRest || []);
                  return dates.map((d, i) => (
                    <span key={d}>
                      {i > 0 && '、'}
                      <span style={over.has(d) ? { color: '#cf1322', fontWeight: 600 } : undefined}>{d.slice(5)}</span>
                    </span>
                  ));
                } },
            ]}
          />
        </Card>
      )}

      {(report?.ruleIssues?.length || 0) > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="规则提醒（早班女性 / 新人带教）"
          description={<div>{report!.ruleIssues.map((issue, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <b>{issue.text}</b>
              <span className="text-muted"> —— 建议：{issue.suggestion}</span>
            </div>
          ))}</div>}
        />
      )}

      <Card
        size="small"
        variant="outlined"
        styles={{ body: { padding: 0 } }}
        title="本周排班（点人数可改该日该班的人数）"
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>列底色：淡蓝=白班、淡黄=中班、淡紫=夜班，橙色行=今天；蓝标签=模板人数，橙标签=临时改过；按住人名可拖拽换班（拖到人=互换、拖到格子=挪过去），点 × 撤下；0 人的格子显示「待排」（灰色空位，点开就能选人补上，不报警）；0&lt;人数&lt;需求才报「缺 N 人」（红色空位）；已经开始的班照常可改，日期旁的 🔒 只锁这一天</Typography.Text>}
      >
        {!data?.schedule && !loading && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '18px 0' }} description="本周还没有班表，点右上角「生成本周班表」就能生成" />
        )}
        <Table rowKey="date" size="small" pagination={false} dataSource={days.map((date) => ({ date }))}
          columns={[
            { title: '日期', dataIndex: 'date', width: 170,
              onCell: (row: { date: string }) => (row.date === todayStr() ? { style: { background: '#ffe7ba' } } : {}),
              render: (date: string) => (
                <Space size={4} wrap>
                  {date === todayStr() && <Tag color="orange" style={{ marginInlineEnd: 0 }}>今天</Tag>}
                  <b>{date.slice(5)} {weekdayCn(date)}</b>
                  {isDayLocked(date) && <Tag color="gold" style={{ marginInlineEnd: 0 }}>🔒 已锁</Tag>}
                  {data?.schedule && !locked && (
                    <Tooltip title={isDayLocked(date)
                      ? '这一天已锁定：生成 / 换人 / 挪班 / 加人 / 删除都要先解锁。点一下解锁这一天'
                      : '锁定这一天的人员安排（只锁这一天，别的天照旧可改）'}>
                      <Button
                        size="small" type="text"
                        icon={isDayLocked(date) ? <LockOutlined /> : <UnlockOutlined />}
                        aria-label={date + (isDayLocked(date) ? '解锁这一天' : '锁定这一天')}
                        onClick={() => toggleDayLock(date)}
                      />
                    </Tooltip>
                  )}
                  {/* B6：整天 0 人（排过后又删空 / 还没排）没东西可删，垃圾桶不再显示 —— 与月表同一口径 */}
                  {data?.schedule && !locked && !isDayLocked(date) && scheduledDates.has(date) && (
                    <Tooltip title="删除这一天的排班">
                      <Button
                        size="small" type="text" danger icon={<DeleteOutlined />}
                        aria-label={date + '删除这一天'}
                        onClick={() => clearDay(date)}
                      />
                    </Tooltip>
                  )}
                </Space>
              ) },
            ...(['early', 'middle', 'night'] as const).map((code) => ({
              title: `${LABEL[code]} ${shifts.find((s) => s.code === code)?.start_time || ''}`,
              key: code,
              onCell: () => ({ style: { background: SHIFT_BG[code] } }),
              onHeaderCell: () => ({ style: { background: SHIFT_BG[code] } }),
              render: (_: unknown, row: { date: string }) => {
                const entries = entryOf(row.date, code);
                const need = demandOf(row.date, code);
                // B6 显示口径：这一格 0 人 → 「待排」（灰色常规，不报警）；0<N<需求 才算「缺 N 人」。
                // 排过后又删空的格子与「没排过」的格子一样显示「待排」，不再报缺员。
                const zero = entries.length === 0;
                const short = Boolean(data?.schedule) && !zero && entries.length < need.demand;
                const missing = Math.max(0, need.demand - entries.length);
                const frozenHere = started(row.date, code);
                const cellFrozen = locked || isDayLocked(row.date);
                // 缺人的位置直接留空位：点开选人即补上，不必等「重算未来班次」。
                // 已经开始的班也能补人（问题①）；只有锁定（整周 / 单日）才拦。
                // 「待排」的格子同样保留补人入口，只是换成灰色虚线，不当成警报。
                const canFill = missing > 0 && Boolean(data?.schedule) && !cellFrozen;
                const hasFemale = entries.some((e) => { const emp = byId.get(e.employee_id); return Boolean(emp && isFemale(emp)); });
                return (
                  <div
                    onDragOver={(ev) => { if (dragEntry && !cellFrozen) { ev.preventDefault(); setDropKey(row.date + code); } }}
                    onDragLeave={() => setDropKey((k) => (k === row.date + code ? null : k))}
                    onDrop={(ev) => { ev.preventDefault(); setDropKey(null); const src = dragEntry; setDragEntry(null); if (src) moveEntry(src, row.date, code); }}
                    style={{ outline: dropKey === row.date + code ? '2px dashed #1677ff' : undefined, padding: 2 }}
                  >
                    <Space size={4} wrap style={{ marginBottom: 4 }}>
                      <Tooltip title="点击修改这一天这个班需要几个人">
                        <Tag
                          color={need.override ? 'orange' : 'blue'}
                          style={{ cursor: cellFrozen ? 'not-allowed' : 'pointer', marginInlineEnd: 0 }}
                          onClick={() => openStaff(row.date, code)}
                        >
                          {need.override ? '临时 ' : ''}{need.demand} 人
                        </Tag>
                      </Tooltip>
                      {frozenHere && <Tooltip title="这个班已经开始：仍然可以换人 / 挪班 / 撤下 / 加人，改动立即生效（问题①修复）">
                        <Tag color="volcano" style={{ marginInlineEnd: 0 }}>已开始·可改</Tag>
                      </Tooltip>}
                      {short && <Tag color="red" style={{ marginInlineEnd: 0 }}>缺 {need.demand - entries.length} 人</Tag>}
                      {entries.length > need.demand && <Tag color="purple" style={{ marginInlineEnd: 0 }}>多 {entries.length - need.demand} 人</Tag>}
                      {code === 'early' && entries.length > 0 && !hasFemale && <Tag color="magenta" style={{ marginInlineEnd: 0 }}>无女性</Tag>}
                    </Space>
                    <div>
                      <Space wrap size={4}>{entries.map((e) => {
                        // 已开始的班不再禁止拖拽 / 换人（问题①）；锁定（整周 / 单日）仍然冻结
                        const dragOk = !cellFrozen && e.status !== 'locked';
                        return (
                          <Space
                            key={e.id} size={2} draggable={dragOk}
                            onDragStart={(ev) => { ev.dataTransfer.setData('text/plain', String(e.id)); ev.dataTransfer.effectAllowed = 'move'; setDragEntry(e); }}
                            onDragEnd={() => { setDragEntry(null); setDropKey(null); }}
                            onDragOver={(ev) => { if (dragEntry && dragOk) { ev.preventDefault(); ev.stopPropagation(); setDropKey('p' + e.id); } }}
                            onDragLeave={() => setDropKey((k) => (k === 'p' + e.id ? null : k))}
                            onDrop={(ev) => { ev.preventDefault(); ev.stopPropagation(); setDropKey(null); const src = dragEntry; setDragEntry(null); if (src) swapEntries(src, e); }}
                            style={{ cursor: dragOk ? 'grab' : 'default', borderRadius: 4, padding: '0 2px',
                              outline: dropKey === 'p' + e.id ? '2px solid #1677ff' : undefined,
                              opacity: dragEntry && dragEntry.id === e.id ? 0.4 : 1 }}
                          >
                            <Select size="small" style={{ width: 104 }} value={e.employee_id} options={peopleOptions.some((x) => x.value === e.employee_id) ? peopleOptions : [{ value: e.employee_id, label: e.employee_name || '已删除员工' }, ...peopleOptions]}
                              disabled={cellFrozen || e.status === 'locked'} onChange={(id) => changePerson(e, id)} aria-label={`${row.date}${LABEL[code]}换人`} />
                            {badgesOf(e.employee_id, row.date, code).map((b) => (
                              <Tag key={b} color={b === '新' ? 'cyan' : b === '带' ? 'green' : 'gold'} style={{ marginInlineEnd: 0 }}>{b}</Tag>
                            ))}

                            {(data?.issues?.[e.id] || []).map((r) => (
                              <Typography.Text key={r} type="danger" style={{ fontSize: 11 }}>{r}</Typography.Text>
                            ))}
                            {dragOk && <Tooltip title="撤下这个人">
                              <Button size="small" type="text" danger icon={<CloseOutlined style={{ fontSize: 10 }} />}
                                onClick={() => removePerson(e)} aria-label={`${row.date}${LABEL[code]}撤下`} />
                            </Tooltip>}
                          </Space>
                        );
                      })}
                      {zero && <Typography.Text type="secondary">待排</Typography.Text>}
                      {canFill && Array.from({ length: missing }).map((_, i) => (
                        // 0 人的格子：灰色虚线空位（待排补人入口，样式不警报）；部分缺员：保持原来的红色空位
                        <span key={'gap' + i} style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 4, padding: '0 2px',
                          border: '1px dashed ' + (zero ? '#d9d9d9' : '#ff7875'),
                          background: zero ? 'transparent' : '#fff1f0' }}>
                          <Select size="small" variant="borderless" style={{ width: 96 }} placeholder="＋ 加上人"
                            value={null} options={gapOptions(row.date, code)}
                            onChange={(id) => fillSlot(row.date, code, Number(id))}
                            aria-label={row.date + LABEL[code] + '空位补人'} />
                        </span>
                      ))}
                      </Space>
                    </div>
                  </div>
                );
              },
            })),
          ]} />
      </Card>

      {diagnosis && <Card title="排不下诊断" size="small" style={{ marginTop: 12 }}>
        <Alert type="error" showIcon message={`月度总量：需求 ${diagnosis.capacity.demand} 人次，可用 ${diagnosis.capacity.available} 人次；具体日期仍有缺口`}
          description={diagnosis.capacity.byMonth.map((m) => `${m.month}：${m.demand}/${m.available}`).join('；')} style={{ marginBottom: 12 }} />
        {diagnosis.missing.map((m, i) => <div key={m.date + m.shift + i} style={{ marginBottom: 10 }}>
          <b>{m.date} {m.shift} 缺 {m.missing} 人</b>
          {/* 一人一行：两个人的姓名不并排出现在同一行里（不搭班是保密约束，聚合提示见下方冲突行） */}
          <div style={{ color: '#cf1322' }}>
            {m.excluded.length
              ? m.excluded.map((e) => <div key={e.employeeId}>{`${e.name}：${e.reasons.join('、')}`}</div>)
              : '现有人数不足'}
          </div>
        </div>)}
        {(diagnosis.over || []).map((o, i) => <div key={'over' + i} style={{ color: '#cf1322', marginBottom: 6 }}>
          {o.date} {o.shift} 已排 {o.assigned} 人，超过当前需求 {o.count} 人
        </div>)}
        {(diagnosis.ruleIssues || []).map((issue, i) => <div key={'rule' + i} style={{ color: '#d46b08', marginBottom: 6 }}>
          {issue.text}（建议：{issue.suggestion}）
        </div>)}
        {diagnosis.conflicts.map((issue, i) => <div key={i} style={{ color: '#cf1322', marginBottom: 6 }}>{issue}</div>)}
        <Alert type="warning" message="可执行的调整建议" description={diagnosis.suggestions.join('；')} />
      </Card>}

      {data?.schedule && !locked && <Button style={{ marginTop: 12 }} danger icon={<ReloadOutlined />} onClick={() => Modal.confirm({
        title: '覆盖未来手工调整？', content: '只会重新计算尚未开始的班次；已经开始或结束的班次不会变化。每次重排都会换一个随机方案。', okText: '覆盖未来手工调整', okButtonProps: { danger: true }, cancelText: '取消',
        onOk: () => perform('/api/schedule/generate', { full: true }),
      })}>覆盖未来手工调整</Button>}

      <Modal
        open={Boolean(staff)}
        title={staff ? `改人数：${staff.date} ${staff.name}` : ''}
        onCancel={() => setStaff(null)}
        onOk={() => saveStaff()}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        width={460}
      >
        {staff && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <div className="text-muted">
              班次模板默认 {staff.base} 人；填 {staff.base} 即为恢复默认。改完引擎生成与诊断会立即按新人数计算。
            </div>
            <Space>
              <span>需要人数</span>
              <InputNumber min={0} max={20} value={staffCount} onChange={(v) => setStaffCount(Number(v) || 0)} style={{ width: 90 }} />
              <span className="text-muted">人</span>
            </Space>
            <Radio.Group value={staffScope} onChange={(e) => setStaffScope(e.target.value)}>
              <Radio.Button value="day">仅本日</Radio.Button>
              <Radio.Button value="same-kind">应用到本月所有同类日</Radio.Button>
            </Radio.Group>
            <Space wrap>
              <span>指定谁来上（可选）</span>
              <Select
                mode="multiple"
                style={{ minWidth: 240 }}
                value={staffPeople}
                onChange={(v) => setStaffPeople(v as number[])}
                options={employees.filter((e) => e.status === 'active').map((e) => ({
                  value: e.id,
                  label: e.name + (e.position === '店长' ? '（店长）' : '') + (isNewbie(e) ? '（新人）' : ''),
                }))}
                placeholder="不点名 = 空座留给引擎自动补"
                disabled={staffScope === 'same-kind'}
                maxTagCount={4}
              />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              点名的人立刻进班（不用重算），座位不够会自动加座；「本月所有同类日」= 与该日期同类型（平日 / 周末 / 法定节假日）的本月其他日期，一次改成同一人数，不能点名。
            </Typography.Text>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              记录会存成一条「临时加派」，可在「排班要求 → 临时加派」里查看或删除。
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </Spin>
  );
}
