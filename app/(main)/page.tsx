'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, App as AntdApp, Button, Card, Col, Row, Space, Spin, Statistic, Tag, Typography } from 'antd';
import {
  CalendarOutlined,
  ClockCircleOutlined,
  OrderedListOutlined,
  ReloadOutlined,
  TableOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { api } from '@/lib/client';
import BackupReminder from '@/components/BackupReminder';
import { formatCn, weekdayCn } from '@/lib/date';
import type { DayType, OverviewData } from '@/lib/types';

const DAY_TYPE_TAG: Record<DayType, { color: string; text: string }> = {
  weekday: 'blue',
  weekend: 'gold',
  holiday: 'red',
} as unknown as Record<DayType, { color: string; text: string }>;

export default function HomePage() {
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.get<OverviewData>('/api/overview'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dayTypeText = (t: DayType) => (t === 'weekday' ? '平日' : t === 'weekend' ? '周末（忙日）' : '法定节假日（忙日）');
  const dayTypeColor = (t: DayType) => (t === 'weekday' ? 'default' : t === 'weekend' ? 'gold' : 'red');
  const peopleFor = (code: string) => data?.todaySchedule.filter((row) => row.shift_code === code).map((row) => row.employee_name) || [];

  return (
    <Spin spinning={loading}>
      <div className="page-title">
        <div>
          <h2>本周班表</h2>
          <div className="sub">
            {data ? formatCn(data.week_start) + '（周一） 至 ' + formatCn(data.week_end) + '（周日）' : '加载中…'}
            {data && <Tag color={data.schedules.current_week_status === 'locked' ? 'green' : data.schedules.current_week_status === 'draft' ? 'orange' : 'default'} style={{ marginLeft: 8 }}>
              {data.schedules.current_week_status === 'locked' ? '本周已锁定' : data.schedules.current_week_status === 'draft' ? '本周为草稿' : '本周未排'}
            </Tag>}
          </div>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button icon={<OrderedListOutlined />} onClick={() => router.push('/requirements')}>
            去填写排班要求
          </Button>
          <Button icon={<CalendarOutlined />} onClick={() => router.push('/schedule')}>
            周排班工作台
          </Button>
          <Button type="primary" icon={<TableOutlined />} onClick={() => router.push('/month')}>
            月度汇总
          </Button>
        </Space>
      </div>

      <BackupReminder />

      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} md={6}>
          <Card variant="outlined">
            <Statistic title="在职员工" value={data?.employees.active ?? 0} suffix="人" prefix={<TeamOutlined />} />
            <div className="text-muted mt-8">
              暂停排班 {data?.employees.leave ?? 0} 人 · 离职 {data?.employees.resigned ?? 0} 人 · 合计{' '}
              {data?.employees.total ?? 0} 人
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card variant="outlined">
            <Statistic
              title="今日需求人次"
              value={data?.demand.today ?? 0}
              suffix="人次"
              prefix={<ClockCircleOutlined />}
            />
            <div className="mt-8">
              今日：
              <Tag color={data ? dayTypeColor(data.demand.today_type) : 'default'}>
                {formatCn(data?.today)} {data ? weekdayCn(data.today) : ''} ·{' '}
                {data ? dayTypeText(data.demand.today_type) : ''}
              </Tag>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card variant="outlined">
            <Statistic
              title={'本年忙日（' + (data?.holidays.year ?? '') + '）'}
              value={data?.holidays.busy_days ?? 0}
              suffix="天"
              prefix={<CalendarOutlined />}
            />
            <div className="text-muted mt-8">
              法定节假日 {data?.holidays.statutory ?? 0} 天 · 调休上班 {data?.holidays.makeup_workday ?? 0} 天
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card variant="outlined">
            <Statistic title="已录入排班要求" value={(data?.requirements.leave ?? 0) + (data?.requirements.avoid ?? 0) + (data?.requirements.extra ?? 0)} suffix="条" />
            <div className="text-muted mt-8">
              请假 {data?.requirements.leave ?? 0} · 避班 {data?.requirements.avoid ?? 0} · 加派{' '}
              {data?.requirements.extra ?? 0}
            </div>
          </Card>
        </Col>
      </Row>

      <Card style={{ marginTop: 16 }} variant="outlined">
        <Space wrap>
          <span>员工、班次人数和排班要求准备好后，在周工作台生成草稿并锁定。</span>
          <Button type="primary" onClick={() => router.push('/schedule')}>打开周排班工作台</Button>
        </Space>
      </Card>

      <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <Card title="今天谁上班" extra={data?.schedules.current_week_status === 'draft' && <Tag color="orange">草稿，未发布</Tag>} variant="outlined" size="small">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {(data?.shifts ?? []).map((s) => (
                  <tr key={s.code} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <td style={{ padding: '6px 0' }}>
                      <b>{s.name}</b>
                    </td>
                    <td className="text-muted">
                      {s.start_time} - {s.end_time}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {peopleFor(s.code).length ? peopleFor(s.code).join('、') : <span className="text-muted">尚未生成</span>}
                    </td>
                  </tr>
                ))}
                {(!data || data.shifts.length === 0) && (
                  <tr>
                    <td className="text-muted">尚未启用任何班次，请到「班次模板」检查</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="容量参考" variant="outlined" size="small">
            {data && (
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                <div>
                  今天需要 <b>{data.demand.today}</b> 人次，实际可排 <b>{data.capacity.todayAvailable}</b> 人。
                </div>
                {data.demand.today > data.capacity.todayAvailable || data.capacity.demand > data.capacity.available ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="人手偏紧"
                    description={
                      (data.demand.today > data.capacity.todayAvailable
                        ? '今天可排人数不足，可能受请假或人员日期限制影响。'
                        : '') +
                      (data.capacity.demand > data.capacity.available
                        ? ' 所涉月份总容量也不足，建议增加员工或降低班次人数。'
                        : '')
                    }
                  />
                ) : (
                  <Alert type="success" showIcon message="容量可行" description="今天和所涉月份的可用人次都覆盖当前需求。" />
                )}
                <div className="text-muted">
                  平日 {data.demand.weekday} 人次 · 周末 {data.demand.weekend} 人次 · 法定节假日 {data.demand.holiday} 人次
                </div>
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Typography.Paragraph className="text-muted mt-12" style={{ fontSize: 12 }}>
        数据库位置：{data?.dbPath}
      </Typography.Paragraph>
    </Spin>
  );
}
