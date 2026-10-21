'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Popconfirm,
  Radio,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import { DeleteOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/lib/client';
import MonthGrid, { type DayCellInfo } from '@/components/MonthGrid';
import { addDays, formatCn, isWeekend, todayStr, weekdayCn } from '@/lib/date';
import type { Holiday } from '@/lib/types';

export default function HolidaysPage() {
  const { message, modal } = AntdApp.useApp();
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [items, setItems] = useState<Holiday[]>([]);
  const [days, setDays] = useState<Record<string, DayCellInfo>>({});
  const [mode, setMode] = useState<'holiday' | 'workday'>('holiday');
  const [loading, setLoading] = useState(true);
  const today = todayStr();

  /** 请求序号：切换年份时慢的旧响应不得把新年份覆盖回去 */
  const reqSeq = useRef(0);
  const load = useCallback(
    async (y: number) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      try {
        const d = await api.get<{ year: number; items: Holiday[]; days: Record<string, DayCellInfo> }>(
          '/api/holidays?year=' + y
        );
        if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃这份过期数据
        setItems(d.items);
        setDays(d.days);
      } catch (err) {
        if (seq === reqSeq.current) message.error(err instanceof Error ? err.message : '加载失败');
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [message]
  );

  useEffect(() => {
    load(year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const info = useCallback(
    (date: string): DayCellInfo => {
      const h = days[date];
      if (h) return h;
      return { type: isWeekend(date) ? 'weekend' : 'weekday' };
    },
    [days]
  );

  const toggle = async (date: string, current: DayCellInfo) => {
    try {
      const r = await api.post<{ action: string }>('/api/holidays', { date, kind: mode });
      if (r.action === 'added' || r.action === 'changed') {
        message.success(
          formatCn(date) + (r.action === 'changed' ? ' 已改为' : ' 已标记为') + (mode === 'holiday' ? '法定节假日（忙日）' : '调休上班日（平日）')
        );
      } else {
        message.success(formatCn(date) + ' 已取消标记');
      }
      load(year);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const reset = () => {
    modal.confirm({
      title: '恢复预置节假日？',
      content:
        '将把 2026（官方）与 2027（预估）年的法定节假日与调休上班日写回日历。已经存在的日期不会重复添加，你手动改过的日期也不会被覆盖。',
      okText: '恢复预置',
      cancelText: '取消',
      onOk: async () => {
        const r = await api.post<{ inserted: number }>('/api/holidays/reset', { year });
        message.success('已写入 ' + r.inserted + ' 条预置数据');
        load(year);
      },
    });
  };

  const stats = useMemo(() => {
    const statutory = items.filter((h) => h.kind === 'holiday').length;
    const makeup = items.filter((h) => h.kind === 'workday').length;
    let busy = 0;
    let cur = year + '-01-01';
    const end = year + '-12-31';
    while (cur <= end) {
      if (info(cur).type !== 'weekday') busy += 1;
      cur = addDays(cur, 1);
    }
    return { statutory, makeup, busy };
  }, [items, info, year]);

  return (
    <>
      <div className="page-title">
        <div>
          <h2>节假日日历</h2>
          <div className="sub">
            周末自动算「忙日」；法定节假日可手动勾选/取消。忙日可按「周末 / 法定节假日」两档单独配置人数。
          </div>
        </div>
        <Space wrap>
          <Button onClick={() => setYear(year - 1)}>上一年</Button>
          <DatePicker
            picker="year"
            allowClear={false}
            value={dayjs(String(year))}
            onChange={(d) => d && setYear(d.year())}
            style={{ width: 110 }}
          />
          <Button onClick={() => setYear(year + 1)}>下一年</Button>
          <Button icon={<ReloadOutlined />} onClick={() => load(year)}>
            刷新
          </Button>
          <Button icon={<UndoOutlined />} onClick={reset}>
            恢复预置
          </Button>
        </Space>
      </div>

      <Row gutter={[12, 12]}>
        <Col span={24}>
          <Alert
            type="info"
            showIcon
            message={
              <Space wrap size={16}>
                <span>
                  当前年份：<b>{year}</b>
                </span>
                <span>
                  法定节假日 <b>{stats.statutory}</b> 天
                </span>
                <span>
                  调休上班 <b>{stats.makeup}</b> 天
                </span>
                <span>
                  全年忙日（周末 + 法定节假日） <b>{stats.busy}</b> 天
                </span>
              </Space>
            }
            description="点击日历中的日期即可标记 / 取消。2027 年官方放假通知尚未发布，预置数据为预估，标记为虚线边框，通知发布后请手动校对。"
          />
        </Col>
        <Col span={24}>
          <Card
            size="small"
            variant="outlined"
            title="点击日历的日期进行标记"
            extra={
              <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} optionType="button" buttonStyle="solid">
                <Radio.Button value="holiday">标记为法定节假日</Radio.Button>
                <Radio.Button value="workday">标记为调休上班日</Radio.Button>
              </Radio.Group>
            }
          >
            <Space wrap size={16} style={{ marginBottom: 8 }}>
              <span>
                <span className="mg-cell mg-weekday" style={{ display: 'inline-block', width: 20, height: 20, lineHeight: '18px' }}>
                  &nbsp;
                </span>{' '}
                平日
              </span>
              <span>
                <span className="mg-cell mg-weekend" style={{ display: 'inline-block', width: 20, height: 20, lineHeight: '18px' }}>
                  &nbsp;
                </span>{' '}
                周末（忙日）
              </span>
              <span>
                <span className="mg-cell mg-holiday" style={{ display: 'inline-block', width: 20, height: 20, lineHeight: '18px' }}>
                  &nbsp;
                </span>{' '}
                法定节假日（忙日）
              </span>
              <span>
                <span className="mg-cell mg-workday" style={{ display: 'inline-block', width: 20, height: 20, lineHeight: '18px' }}>
                  &nbsp;
                </span>{' '}
                调休上班（平日）
              </span>
            </Space>

            <Row gutter={[12, 12]}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <Col key={m} xs={24} sm={12} md={8} lg={6}>
                  <MonthGrid year={year} month={m} info={info} today={today} onToggle={toggle} />
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
      </Row>

      <Card
        title={'本年节假日清单（' + year + '）'}
        style={{ marginTop: 16 }}
        variant="outlined"
        styles={{ body: { padding: 0 } }}
      >
        <Table<Holiday>
          rowKey="id"
          loading={loading}
          dataSource={items}
          pagination={{ pageSize: 15, showTotal: (t) => '共 ' + t + ' 条' }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '本年还没有任何节假日标记，点上方「恢复预置」写入 2026/2027 法定节假日' }}
          columns={[
            { title: '日期', dataIndex: 'date', width: 160, render: (v: string) => formatCn(v) },
            { title: '星期', key: 'week', width: 80, render: (_, row) => weekdayCn(row.date) },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 130,
              render: (v: string) =>
                v === 'holiday' ? <Tag color="red">法定节假日（忙日）</Tag> : <Tag color="green">调休上班（平日）</Tag>,
            },
            {
              title: '名称',
              dataIndex: 'name',
              render: (v: string, row) => (
                <Space>
                  <span>{v}</span>
                  {row.estimated === 1 && <Tag color="orange">预估</Tag>}
                  {row.is_preset === 0 && <Tag>手动标记</Tag>}
                </Space>
              ),
            },
            {
              title: '操作',
              key: 'action',
              width: 100,
              render: (_, row) => (
                <Popconfirm
                  title="取消这个标记？"
                  okText="确认取消"
                  cancelText="再想想"
                  onConfirm={async () => {
                    await api.del('/api/holidays?date=' + row.date);
                    message.success('已取消：' + formatCn(row.date));
                    load(year);
                  }}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    取消
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Tooltip title="周末由系统自动判定，无需手动标记；如需把某个周末改成平日（调休上班），请用「标记为调休上班日」">
        <span className="text-muted" style={{ fontSize: 12, display: 'inline-block', marginTop: 8 }}>
          说明：周末自动算忙日；本页只需维护法定节假日与调休上班日。
        </span>
      </Tooltip>
    </>
  );
}
