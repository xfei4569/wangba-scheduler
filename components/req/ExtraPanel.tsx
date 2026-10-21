'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
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
import type { Requirement, ShiftTemplate } from '@/lib/types';
import { formatCn, weekdayCn } from '@/lib/date';

interface Values {
  date: dayjs.Dayjs;
  shift_code: string;
  override_count: number;
  employee_ids?: number[];
  note?: string;
}

export default function ExtraPanel({ shifts }: { shifts: ShiftTemplate[] }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<Values>();
  const [items, setItems] = useState<Requirement[]>([]);
  const [people, setPeople] = useState<{ id: number; name: string; status: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const picked = Form.useWatch('date', form);

  const shiftOf = (code: string) => shifts.find((s) => s.code === code);
  const shiftName = (code: string) => shiftOf(code)?.name || code;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, p] = await Promise.all([
        api.get<{ items: Requirement[] }>('/api/requirements?type=extra'),
        api.get<{ items: { id: number; name: string; status: string }[] }>('/api/employees'),
      ]);
      setItems(d.items);
      setPeople(p.items.filter((e) => e.status === 'active'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  const hint = useMemo(() => {
    if (!picked) return '';
    const date = picked.format('YYYY-MM-DD');
    const code = form.getFieldValue('shift_code') as string | undefined;
    const s = code ? shiftOf(code) : undefined;
    return s ? '默认人数会按这一天的节假日设置计算，' + s.name + '可在此覆盖' : '请选择班次查看默认人数';
  }, [picked, form, shifts]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (values: Values) => {
    setSaving(true);
    try {
      // 走「加派」接口：可以点名把某个人钉进这一天这个班，不点名就只改人数
      await api.post('/api/schedule/staffing', {
        date: values.date.format('YYYY-MM-DD'),
        shift_code: values.shift_code,
        count: values.override_count,
        scope: 'day',
        employee_ids: values.employee_ids || [],
        note: values.note || '',
      });
      message.success(values.employee_ids?.length ? '已加派，并点名排进 ' + values.employee_ids.length + ' 个人' : '已登记临时加派');
      form.resetFields(['note', 'employee_ids']);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: Requirement) => {
    try {
      await api.del('/api/requirements/' + row.id);
      message.success('已删除');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <>
      <Card title="登记临时加派（指定日期、指定班次的人数覆盖）" variant="outlined" size="small" className="mb-12">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="指定哪一天、哪个班、排谁"
          description="例如：10 月 5 日晚班填 3，点名张三、李四 —— 这两个人立刻排进 10 月 5 日晚班，剩下的位置交给系统补。不点名就只改人数。"
        />
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ override_count: 3 }}>
          <Row gutter={12}>
            <Col xs={24} md={5}>
              <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker style={{ width: '100%' }} placeholder="选择加派日期" />
              </Form.Item>
            </Col>
            <Col xs={24} md={5}>
              <Form.Item name="shift_code" label="班次" rules={[{ required: true, message: '请选择班次' }]}>
                <Select
                  placeholder="选择班次"
                  options={shifts.map((s) => ({ value: s.code, label: s.name + '（' + s.start_time + '-' + s.end_time + '）' }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="override_count" label="人数" rules={[{ required: true, message: '请填写人数' }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="employee_ids" label="点名排进这个班（可不填）">
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="不填就只改人数，排谁交给系统"
                  options={people.map((e) => ({ value: e.id, label: e.name }))}
                  maxTagCount="responsive"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="note" label="备注">
                <Input placeholder="例如：国庆忙日加派" maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Space>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={saving}>
              登记
            </Button>
            <Button onClick={() => form.resetFields()}>重置</Button>
            {hint && <span className="text-muted">{hint}</span>}
          </Space>
        </Form>
      </Card>

      <Card
        title={'已登记的临时加派（' + items.length + ' 条）'}
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
          locale={{ emptyText: '还没有临时加派记录' }}
          columns={[
            {
              title: '日期',
              dataIndex: 'date_start',
              width: 200,
              render: (v: string) => (
                <span>
                  {formatCn(v)} <span className="text-muted">{weekdayCn(v)}</span>
                </span>
              ),
            },
            {
              title: '班次',
              dataIndex: 'shift_codes',
              width: 140,
              render: (codes: string[]) => <Tag color="blue">{shiftName((codes || [])[0])}</Tag>,
            },
            {
              title: '覆盖人数',
              dataIndex: 'override_count',
              width: 110,
              align: 'center' as const,
              render: (v: number) => <b>{v} 人</b>,
            },
            { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string | null) => v || <span className="text-muted">—</span> },
            {
              title: '操作',
              key: 'action',
              width: 90,
              render: (_: unknown, row: Requirement) => (
                <Popconfirm title="删除这条加派记录？" okText="删除" cancelText="取消" onConfirm={() => remove(row)}>
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
