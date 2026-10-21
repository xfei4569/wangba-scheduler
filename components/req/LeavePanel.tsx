'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/lib/client';
import { EMPLOYEE_STATUS_LABEL, LEAVE_TYPES, type Employee, type Requirement } from '@/lib/types';
import { eachDate, formatCn } from '@/lib/date';
import { noticeStaleWeeks } from '@/lib/stale-notice';

const employeeOptions = (employees: Employee[], opts: { allowResigned?: boolean } = {}) =>
  employees
    .filter((e) => opts.allowResigned || e.status !== 'resigned')
    .map((e) => ({
      value: e.id,
      label: e.name + '（' + EMPLOYEE_STATUS_LABEL[e.status] + '）',
      disabled: !opts.allowResigned && e.status === 'resigned',
    }));

interface Values {
  employee_id: number;
  leave_type: string;
  range: [dayjs.Dayjs, dayjs.Dayjs];
  note?: string;
}

export default function LeavePanel({ employees }: { employees: Employee[] }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<Values>();
  const [items, setItems] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ items: Requirement[] }>('/api/requirements?type=leave');
      setItems(d.items);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (values: Values) => {
    setSaving(true);
    try {
      const saved = await api.post<{ stale_weeks?: string[] }>('/api/requirements', {
        type: 'leave',
        employee_id: values.employee_id,
        leave_type: values.leave_type,
        date_start: values.range[0].format('YYYY-MM-DD'),
        date_end: values.range[1].format('YYYY-MM-DD'),
        note: values.note || '',
      });
      message.success('已登记请假');
      noticeStaleWeeks(saved.stale_weeks, '这条请假');
      form.resetFields(['note']);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: Requirement) => {
    try {
      const removed = await api.del<{ stale_weeks?: string[] }>('/api/requirements/' + row.id);
      message.success('已删除');
      noticeStaleWeeks(removed.stale_weeks, '删掉这条请假');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <>
      <Card title="登记请假 / 月休" variant="outlined" size="small" className="mb-12">
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ leave_type: '事假' }}>
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item name="employee_id" label="员工" rules={[{ required: true, message: '请选择员工' }]}>
                <Select placeholder="选择员工" options={employeeOptions(employees)} showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="range" label="请假日期区间" rules={[{ required: true, message: '请选择日期区间' }]}>
                <DatePicker.RangePicker style={{ width: '100%' }} placeholder={['开始日期', '结束日期']} />
              </Form.Item>
            </Col>
            <Col xs={24} md={5}>
              <Form.Item name="leave_type" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
                <Radio.Group optionType="button" buttonStyle="solid">
                  {LEAVE_TYPES.map((t) => (
                    <Radio.Button key={t} value={t}>
                      {t}
                    </Radio.Button>
                  ))}
                </Radio.Group>
              </Form.Item>
            </Col>
            <Col xs={24} md={5}>
              <Form.Item name="note" label="备注">
                <Input placeholder="选填" maxLength={60} />
              </Form.Item>
            </Col>
          </Row>
          <Space>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={saving}>
              登记
            </Button>
            <Button onClick={() => form.resetFields()}>重置</Button>
          </Space>
        </Form>
      </Card>

      <Card
        title={'已登记的请假（' + items.length + ' 条）'}
        variant="outlined"
        size="small"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table<Requirement>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={items}
          pagination={{ pageSize: 10, showTotal: (t) => '共 ' + t + ' 条' }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '还没有请假记录' }}
          columns={[
            { title: '员工', dataIndex: 'employee_name', width: 120, render: (v: string) => <b>{v || '—'}</b> },
            {
              title: '类型',
              dataIndex: 'leave_type',
              width: 100,
              render: (v: string) => <Tag color={v === '月休' ? 'blue' : v === '病假' ? 'red' : 'orange'}>{v}</Tag>,
            },
            { title: '开始日期', dataIndex: 'date_start', width: 150, render: (v: string) => formatCn(v) },
            { title: '结束日期', dataIndex: 'date_end', width: 150, render: (v: string) => formatCn(v) },
            {
              title: '天数',
              key: 'days',
              width: 80,
              align: 'center' as const,
              render: (_: unknown, row: Requirement) =>
                row.date_start && row.date_end ? eachDate(row.date_start, row.date_end).length : '—',
            },
            { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string | null) => v || <span className="text-muted">—</span> },
            {
              title: '操作',
              key: 'action',
              width: 90,
              render: (_: unknown, row: Requirement) => (
                <Popconfirm title="删除这条请假记录？" okText="删除" cancelText="取消" onConfirm={() => remove(row)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
