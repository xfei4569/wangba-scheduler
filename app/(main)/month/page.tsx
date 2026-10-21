'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Empty,
  Modal,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  FieldTimeOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/lib/client';
import { exportPeopleMatrixExcel, LEAVE_CELL, PENDING_CELL, REST_CELL, SHIFT_CELL_CN } from '@/lib/excel';
import { monthGenerateFeedback } from '@/lib/scheduler/month-feedback';
import { isMentor, isNewbie } from '@/lib/types';
import BackupReminder from '@/components/BackupReminder';

interface ShiftCell {
  code: string;
  name: string;
  start_time: string;
  demand: number;
  base: number;
  override: boolean;
  people: { id: number; name: string; source: string }[];
}
interface MonthDay {
  date: string;
  day: number;
  weekday: string;
  day_type: 'weekday' | 'weekend' | 'holiday';
  day_type_cn: string;
  holiday_name: string | null;
  week_start: string;
  week_status: 'locked' | 'draft' | 'none';
  scheduled: boolean;
  /** 单日锁定（问题③）：这一天的人员安排被单独冻结 */
  day_locked: boolean;
  shifts: ShiftCell[];
  leaves: { employeeId: number; name: string; type: string }[];
}
interface MonthPerson {
  employeeId: number;
  name: string;
  status: string;
  gender: string;
  seniority: string;
  can_teach: number;
  position: string;
  workDays: number;
  restDays: number;
  early: number;
  middle: number;
  night: number;
  restTarget: number;
}
interface MonthSummary {
  month: string;
  month_label: string;
  total_days: number;
  scheduled_days: number;
  pending_days: number;
  weeks: { weekStart: string; weekEnd: string; status: 'locked' | 'draft' | 'none'; label: string }[];
  days: MonthDay[];
  people: MonthPerson[];
  shifts: { code: string; name: string; start_time: string; end_time: string }[];
  rest_requirement: number;
  /** 店长月休下限（0 = 不设下限） */
  manager_rest_requirement: number;
  draft_weeks: number;
  has_draft: boolean;
}
interface Diagnosis {
  capacity: { demand: number; available: number; byMonth: { month: string; demand: number; available: number }[] };
  missing: { date: string; shift: string; missing: number; excluded: { name: string; reasons: string[] }[]; suggestion: string }[];
  conflicts: string[];
  suggestions: string[];
  over?: { date: string; shift: string; assigned: number; count: number }[];
}

const DAY_TYPE_COLOR: Record<string, string> = { weekday: 'default', weekend: 'gold', holiday: 'red' };

export default function MonthPage() {
  const { message, modal } = AntdApp.useApp();
  const [month, setMonth] = useState<string>(() => dayjs().format('YYYY-MM'));
  const [data, setData] = useState<MonthSummary | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // B7：默认不勾选自动锁定 —— 整月排完立刻全月锁定会让用户「改不了」，要改还得先逐周解锁。
  const [autoLock, setAutoLock] = useState(false);
  const [exporting, setExporting] = useState(false);

  /** 请求序号：翻月时慢的旧响应不得把新月份覆盖回去 */
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const d = await api.get<MonthSummary>('/api/month?month=' + month);
      if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃这份过期数据
      setData(d);
    } catch (err) {
      if (seq === reqSeq.current) message.error(err instanceof Error ? err.message : '加载失败');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [month, message]);

  useEffect(() => {
    load();
  }, [load]);

  // 支持用地址栏指定月份，例如 /month?month=2026-11
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('month');
    if (value && /^\d{4}-\d{2}$/.test(value)) setMonth(value);
  }, []);

  const shiftMonth = (delta: number) => {
    setDiagnosis(null);
    setMonth(dayjs(month + '-01').add(delta, 'month').format('YYYY-MM'));
  };

  const generateMonth = () => {
    modal.confirm({
      title: '一键排整月？',
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>
            将按自然周依次生成 <b>{data?.month_label}</b> 的排班（已锁定<b>且已排人</b>的周自动跳过；空周照排）；若其中一周排不下，本次新生成的草稿会全部撤销并给出诊断。
          </p>
          <Checkbox checked={autoLock} onChange={(e) => setAutoLock(e.target.checked)}>
            排完后自动锁定（锁了要改需先解锁）
          </Checkbox>
        </div>
      ),
      okText: '开始排班',
      cancelText: '取消',
      onOk: async () => {
        setBusy(true);
        try {
          const result = await api.post<{ ok: boolean; weekStart?: string; diagnosis?: Diagnosis; rolled_back_weeks?: string[]; results: { weekStart: string; ok: boolean; skipped?: string; assigned?: number }[]; generated_weeks?: string[]; skipped_weeks?: string[] }>(
            '/api/month/generate',
            { month, lock: autoLock }
          );
          if (!result.ok) {
            setDiagnosis(result.diagnosis || null);
            const undone = result.rolled_back_weeks?.length
              ? '；' + result.rolled_back_weeks.join('、') + ' 已生成的草稿已全部撤销，没有保存'
              : '；本次新生成的草稿已全部撤销，没有保存';
            message.warning(result.weekStart + ' 这一周排不下' + undone + '。请按诊断调整后再排整月');
          } else {
            setDiagnosis(null);
            // B7 反馈细分：新排 X 周（起止），跳过已锁定 Y 周（起止）+ 解锁提示（不再说「共处理 N 周」）
            message.success(monthGenerateFeedback({ generated_weeks: result.generated_weeks, skipped_weeks: result.skipped_weeks }));
          }
          await load();
        } catch (err) {
          message.error(err instanceof Error ? err.message : '排班失败');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const clearDay = (date: string) => {
    modal.confirm({
      title: '删除 ' + date + ' 的排班？',
      content: '这一天的班会全部删掉，包括已经开始的。已锁定的日期要先解锁。删完可以重新排，不影响别的天。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await api.post<{ removed: number; kept_locked: string[] }>('/api/schedule/clear', { scope: 'day', from: date });
        message.success('已删除 ' + result.removed + ' 条班次' + (result.kept_locked.length ? '（这天已锁定所以保留）' : ''));
        await load();
      },
    });
  };

  const clearMonth = () => {
    modal.confirm({
      title: '删除 ' + (data?.month_label || month) + ' 的排班？',
      content: '这个月已排的班会删掉，包括今天已经开始的。已锁定的日期会保留，需要先解锁才能删。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await api.post<{ removed: number; kept_locked: string[] }>('/api/schedule/clear', { scope: 'month', from: month + '-01' });
        message.success('已删除 ' + result.removed + ' 条班次' + (result.kept_locked.length ? '，' + result.kept_locked.length + ' 天已锁定所以保留' : ''));
        await load();
      },
    });
  };

  const exportMonth = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const people = data.people.map((p) => ({
        name: p.name + (p.position === '店长' ? '（店长）' : '') + (isNewbie(p) ? '（新人）' : ''),
        cells: data.days.map((d) => {
          const hit = d.shifts.find((c) => c.people.some((q) => q.id === p.employeeId));
          if (hit) return SHIFT_CELL_CN[hit.code] || hit.code;
          if (d.leaves.some((l) => l.employeeId === p.employeeId)) return LEAVE_CELL;
          return d.scheduled ? REST_CELL : PENDING_CELL;
        }),
      }));
      await exportPeopleMatrixExcel({
        title: '排班表 ' + data.month_label,
        dates: data.days.map((d) => d.date),
        people,
        // 「按班次」sheet：一天一行，列是各班次（人数 + 名字）
        shiftHeaders: data.shifts.map((s) => s.name + ' ' + s.start_time),
        shiftCells: data.days.map((d) => data.shifts.map((s) => {
          const cell = d.shifts.find((x) => x.code === s.code);
          return {
            people: (cell?.people || []).map((p) => {
              const emp = data.people.find((x) => x.employeeId === p.id);
              if (!emp) return p.name;
              return p.name + (emp.position === '店长' ? '（店长）' : '') + (isNewbie(emp) ? '（新人）' : '');
            }),
            demand: cell?.demand ?? 0,
          };
        })),
        note: data.pending_days
          ? '注：本表按自然月（1 号~月末）导出；空缺 ' + data.pending_days + ' 天（黄色格子）：' +
            data.days.filter((d) => !d.scheduled).map((d) => d.date.slice(5)).join('、') + '。可先把手工排的填进去，系统补排后会覆盖。'
          : '注：本表按自然月（1 号~月末）导出，本月 ' + data.total_days + ' 天均已排班。',
        fileName: '排班表-' + month + '.xlsx',
      });
      message.success('已导出 排班表-' + month + '.xlsx');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const stats = useMemo(() => {
    if (!data) return [];
    return data.people.map((p) => ({
      ...p,
      low: p.workDays > 0 && p.restDays < p.restTarget,
    }));
  }, [data]);

  const pendingWeeks = data?.weeks.filter((w) => w.status === 'none') || [];

  return (
    <Spin spinning={loading}>
      <div className="page-title">
        <div>
          <h2>月度汇总</h2>
          <div className="sub">
            {data ? data.month_label + ' · 已排 ' + data.scheduled_days + ' / ' + data.total_days + ' 天' : '加载中…'}
          </div>
        </div>
        <Space wrap>
          <Button icon={<LeftOutlined />} onClick={() => shiftMonth(-1)}>上月</Button>
          <DatePicker
            picker="month"
            allowClear={false}
            value={dayjs(month + '-01')}
            onChange={(d) => d && setMonth(d.format('YYYY-MM'))}
            style={{ width: 120 }}
          />
          <Button icon={<RightOutlined />} onClick={() => shiftMonth(1)}>下月</Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} onClick={generateMonth}>一键排整月</Button>
          <Button icon={<DownloadOutlined />} loading={exporting} disabled={!data} onClick={exportMonth}>导出整月 Excel</Button>
          <Button danger icon={<DeleteOutlined />} disabled={!data?.scheduled_days} onClick={clearMonth}>删除这个月</Button>
        </Space>
      </div>

      <BackupReminder />

      {data && (
        <Alert
          type={data.pending_days ? 'info' : 'success'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space wrap size={16}>
              <span>每人每月月休要求：<b>{data.rest_requirement}</b> 天</span>
              <span>店长月休下限：<b>{data.manager_rest_requirement > 0 ? data.manager_rest_requirement + ' 天' : '不设下限（0）'}</b></span>
              <span>已排 <b>{data.scheduled_days}</b> 天</span>
              <span>统计口径：<b>当天有任何人员安排才算已排（含草稿）</b>，整天 0 人视同待排</span>
              {data.pending_days > 0 && <span style={{ color: '#d46b08' }}>待排 {data.pending_days} 天</span>}
            </Space>
          }
          description={
            pendingWeeks.length
              ? '尚未生成的周：' + pendingWeeks.map((w) => w.label + '（尚未排班）').join('；')
              : data.pending_days > 0
                ? '本月 ' + data.pending_days + ' 天没有任何人员安排（格子里显示「待排」，可能是还没排或排过后又删空了），一键排整月会补上；草稿周还能改，锁定后即定稿。'
                : '本月所有周都已生成；草稿周还能改，锁定后即定稿。'
          }
        />
      )}

      {diagnosis && (
        <Card title="排不下诊断" size="small" style={{ marginBottom: 12 }}>
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={'月度总量：需求 ' + diagnosis.capacity.demand + ' 人次，可用 ' + diagnosis.capacity.available + ' 人次；具体日期仍有缺口'}
            description={diagnosis.capacity.byMonth.map((m) => m.month + '：' + m.demand + '/' + m.available).join('；')}
          />
          {diagnosis.missing.map((m, i) => (
            <div key={m.date + m.shift + i} style={{ marginBottom: 10 }}>
              <b>{m.date} {m.shift} 缺 {m.missing} 人</b>
              {/* 一人一行：两个人的姓名不并排出现在同一行里（不搭班是保密约束，聚合提示见下方冲突行） */}
              <div style={{ color: '#cf1322' }}>
                {m.excluded.length
                  ? m.excluded.map((e, j) => <div key={j}>{e.name + '：' + e.reasons.join('、')}</div>)
                  : '现有人数不足'}
              </div>
            </div>
          ))}
          {(diagnosis.over || []).map((o, i) => (
            <div key={'over' + i} style={{ color: '#cf1322', marginBottom: 6 }}>
              {o.date} {o.shift} 已排 {o.assigned} 人，超过当前需求 {o.count} 人
            </div>
          ))}
          {diagnosis.conflicts.map((issue, i) => (
            <div key={i} style={{ color: '#cf1322', marginBottom: 6 }}>{issue}</div>
          ))}
          <Alert type="warning" message="可执行的调整建议" description={diagnosis.suggestions.join('；')} />
        </Card>
      )}

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={16}>
          <Card size="small" variant="outlined" styles={{ body: { padding: 0 } }} title={data ? data.month_label + ' 排班网格' : '排班网格'}>
            <Table<MonthDay>
              rowKey="date"
              size="small"
              loading={loading}
              dataSource={data?.days || []}
              pagination={false}
              scroll={{ x: 'max-content' }}
              rowClassName={(row) => (row.scheduled ? '' : 'month-pending-row')}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个月还没有数据" /> }}
              columns={[
                {
                  title: '日期',
                  dataIndex: 'date',
                  width: 160,
                  fixed: 'left',
                  render: (_: unknown, row: MonthDay) => (
                    <Space size={4}>
                      <b>{row.day} 日</b>
                      <span className="text-muted">{row.weekday}</span>
                      {row.day_type !== 'weekday' && (
                        <Tooltip title={row.holiday_name || row.day_type_cn}>
                          <Tag color={DAY_TYPE_COLOR[row.day_type]} style={{ marginInlineEnd: 0 }}>{row.day_type_cn}</Tag>
                        </Tooltip>
                      )}
                      {row.day_locked && (
                        <Tooltip title={'这一天已单独锁定：到周排班页解锁后才能改 ' + row.date + ' 的人员安排'}>
                          <Tag color="gold" style={{ marginInlineEnd: 0 }}>🔒 已锁</Tag>
                        </Tooltip>
                      )}
                      {row.scheduled && !row.day_locked && (
                        <Tooltip title={'删除 ' + row.date + ' 的排班'}>
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={row.date + '删除这一天'} onClick={() => clearDay(row.date)} />
                        </Tooltip>
                      )}
                    </Space>
                  ),
                },
                ...(data?.shifts || []).map((s) => ({
                  title: s.name + ' ' + s.start_time,
                  key: s.code,
                  width: 168,
                  render: (_: unknown, row: MonthDay) => {
                    const cell = row.shifts.find((x) => x.code === s.code);
                    if (!row.scheduled) return <Typography.Text type="secondary">待排</Typography.Text>;
                    if (!cell) return <Typography.Text type="secondary">—</Typography.Text>;
                    // B6：这一格 0 人 → 「待排」（灰色常规文本，不报缺员）；0<N<需求 才算「缺 N 人」。
                    // 混合日（别的班有人）里被删空的这个班，同样显示「待排」而不是红色「缺 N 人」。
                    const empty = cell.people.length === 0;
                    const shortfall = !empty && cell.people.length < cell.demand;
                    const crowded = cell.people.length > cell.demand;
                    return (
                      <div>
                        <div>
                          {cell.people.length ? (
                            <Space size={4} wrap>
                              {cell.people.map((p) => {
                                const emp = (data?.people || []).find((x) => x.employeeId === p.id);
                                if (!emp) return <span key={p.id}>{p.name}</span>;
                                const isNew = isNewbie(emp);
                                const mentorHere = isMentor(emp) && !isNew
                                  && cell.people.some((q) => {
                                    const qe = (data?.people || []).find((x) => x.employeeId === q.id);
                                    return Boolean(qe && isNewbie(qe));
                                  });
                                return (
                                  <span key={p.id} style={{ whiteSpace: 'nowrap' }}>
                                    {p.name}
                                    {emp.position === '店长' && <Tag color="gold" style={{ marginInlineStart: 2 }}>店长</Tag>}
                                    {isNew && <Tag color="cyan" style={{ marginInlineStart: 2 }}>新</Tag>}
                                    {mentorHere && <Tag color="green" style={{ marginInlineStart: 2 }}>带</Tag>}
                                  </span>
                                );
                              })}
                            </Space>
                          ) : (
                            <Typography.Text type="secondary">待排</Typography.Text>
                          )}
                        </div>
                        {(cell.override || shortfall || crowded) && (
                          <Space size={4} wrap>
                            {cell.override && (
                              <a href={'/schedule?week=' + row.week_start} title="到周排班改人数或点名">
                                <Tag color="orange" style={{ marginInlineEnd: 0, cursor: 'pointer' }}>临时 {cell.demand} 人</Tag>
                              </a>
                            )}
                            {shortfall && <Tag color="red" style={{ marginInlineEnd: 0 }}>缺 {cell.demand - cell.people.length} 人</Tag>}
                            {crowded && <Tag color="purple" style={{ marginInlineEnd: 0 }}>多 {cell.people.length - cell.demand} 人</Tag>}
                          </Space>
                        )}
                      </div>
                    );
                  },
                })),
                {
                  title: '请假 / 月休',
                  key: 'leaves',
                  width: 200,
                  render: (_: unknown, row: MonthDay) =>
                    row.leaves.length ? (
                      <Space size={4} wrap>
                        {row.leaves.map((l) => (
                          <Tag key={l.employeeId + l.type} color="default" style={{ background: '#f0f0f0', marginInlineEnd: 0 }}>
                            {l.name}·{l.type}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            size="small"
            variant="outlined"
            title="每人统计（截至已排周）"
            styles={{ body: { padding: 0 } }}
            extra={<Tooltip title="月休天数 = 已排日期 − 出勤天数（含登记请假）；未排日期不计入统计"><FieldTimeOutlined /></Tooltip>}
          >
            <Table<MonthPerson & { low: boolean }>
              rowKey="employeeId"
              size="small"
              loading={loading}
              dataSource={stats}
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可统计的员工" /> }}
              columns={[
                { title: '姓名', dataIndex: 'name', width: 88, render: (v: string) => <b>{v}</b> },
                { title: '出勤', dataIndex: 'workDays', width: 56, align: 'center' as const },
                {
                  title: '月休',
                  dataIndex: 'restDays',
                  width: 56,
                  align: 'center' as const,
                  render: (v: number, row) => (
                    <Tooltip title={'按已排 ' + (data?.scheduled_days || 0) + ' 天折算，当前应休约 ' + row.restTarget + ' 天'}>
                      <span style={{ color: row.low ? '#d46b08' : undefined, fontWeight: row.low ? 600 : undefined }}>{v}</span>
                    </Tooltip>
                  ),
                },
                { title: '早班', dataIndex: 'early', width: 56, align: 'center' as const },
                { title: '中班', dataIndex: 'middle', width: 56, align: 'center' as const },
                { title: '晚班', dataIndex: 'night', width: 56, align: 'center' as const },
              ]}
            />
          </Card>
          <Card size="small" variant="outlined" title="说明" style={{ marginTop: 12 }}>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 12, lineHeight: 2 }}>
              <li>已生成的周（含草稿）都展示并计入统计；未生成的天显示「待排」。</li>
              <li>月休要求来自「设置 → 每人每月最少休息天数」，当前 {data?.rest_requirement ?? '—'} 天。</li>
              <li>橙色的「临时 N 人」表示该日该班被单独改过人数（周工作台可改）。</li>
              <li>本月共 {data?.weeks.length ?? 0} 个自然周，其中已锁定 {data?.weeks.filter((w) => w.status === 'locked').length ?? 0} 个。</li>
            </ul>
          </Card>
        </Col>
      </Row>
    </Spin>
  );
}
