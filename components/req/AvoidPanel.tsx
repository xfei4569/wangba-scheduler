'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Form,
  Input,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/lib/client';
import { EMPLOYEE_STATUS_LABEL, type Employee, type Requirement, type ShiftTemplate } from '@/lib/types';
import { formatRangeCn } from '@/lib/date';
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
  shift_codes: string[];
  long_term: boolean;
  range?: [dayjs.Dayjs, dayjs.Dayjs];
  note?: string;
}

export default function AvoidPanel({ employees, shifts }: { employees: Employee[]; shifts: ShiftTemplate[] }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<Values>();
  const [items, setItems] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const longTerm = Form.useWatch('long_term', form);

  const shiftName = (code: string) => shifts.find((s) => s.code === code)?.name || code;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ items: Requirement[] }>('/api/requirements?type=avoid');
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
    if (!values.long_term && !values.range) {
      message.error('请选择日期区间，或勾选「长期有效」');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.post<{ stale_weeks?: string[] }>('/api/requirements', {
        type: 'avoid',
        employee_id: values.employee_id,
        shift_codes: values.shift_codes,
        long_term: values.long_term ? 1 : 0,
        date_start: values.long_term ? null : values.range?.[0].format('YYYY-MM-DD'),
        date_end: values.long_term ? null : values.range?.[1].format('YYYY-MM-DD'),
        note: values.note || '',
      });
      message.success('已登记避班');
      noticeStaleWeeks(saved.stale_weeks, '这条避班');
      form.resetFields(['note', 'shift_codes']);
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
      noticeStaleWeeks(removed.stale_weeks, '删掉这条避班');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <>
      <Card title="登记避班（某人不上某个班次）" variant="outlined" size="small" className="mb-12">
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ long_term: true }}>
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item name="employee_id" label="员工" rules={[{ required: true, message: '请选择员工' }]}>
                <Select placeholder="选择员工" options={employeeOptions(employees)} showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col xs={24} md={7}>
              <Form.Item name="shift_codes" label="不上哪些班次" rules={[{ required: true, message: '请选择班次' }]}>
                <Select
                  mode="multiple"
                  placeholder="可多选"
                  options={shifts.map((s) => ({
                    value: s.code,
                    label: s.name + '（' + s.start_time + '-' + s.end_time + '）',
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={7}>
              <Form.Item name="range" label="生效日期（勾选长期有效则不用填）">
                <DatePicker.RangePicker
                  style={{ width: '100%' }}
                  disabled={Boolean(longTerm)}
                  placeholder={['开始日期', '结束日期']}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="long_term" valuePropName="checked" label=" ">
                <Checkbox>长期有效</Checkbox>
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12} align="bottom">
            <Col xs={24} md={12}>
              <Form.Item name="note" label="备注">
                <Input placeholder="例如：接送小孩，不能上早班" maxLength={60} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label=" ">
                <Space>
                  <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={saving}>
                    登记
                  </Button>
                  <Button onClick={() => form.resetFields()}>重置</Button>
                </Space>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <Card
        title={'已登记的避班（' + items.length + ' 条）'}
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
          locale={{ emptyText: '还没有避班记录' }}
          columns={[
            { title: '员工', dataIndex: 'employee_name', width: 120, render: (v: string) => <b>{v || '—'}</b> },
            {
              title: '不上的班次',
              dataIndex: 'shift_codes',
              width: 220,
              render: (codes: string[]) => (
                <Space size={4} wrap>
                  {(codes || []).map((c) => (
                    <Tag key={c} color="volcano">
                      {shiftName(c)}
                    </Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: '有效期',
              key: 'period',
              width: 260,
              render: (_: unknown, row: Requirement) =>
                row.long_term === 1 ? <Tag color="purple">长期有效</Tag> : formatRangeCn(row.date_start, row.date_end),
            },
            { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string | null) => v || <span className="text-muted">—</span> },
            {
              title: '操作',
              key: 'action',
              width: 90,
              render: (_: unknown, row: Requirement) => (
                <Popconfirm title="删除这条避班记录？" okText="删除" cancelText="取消" onConfirm={() => remove(row)}>
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
