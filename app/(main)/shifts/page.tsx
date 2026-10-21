'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Space,
  Table,
  Tag,
  TimePicker,
} from 'antd';
import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/lib/client';
import type { Employee, ShiftTemplate } from '@/lib/types';

interface FormValues {
  name: string;
  start_time: dayjs.Dayjs;
  end_time: dayjs.Dayjs;
  cross_day: boolean;
  weekday_count: number;
  weekend_count: number;
  holiday_count: number;
  enabled: boolean;
  note?: string;
}

export default function ShiftsPage() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [items, setItems] = useState<ShiftTemplate[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ShiftTemplate | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [s, e] = await Promise.all([
        api.get<{ items: ShiftTemplate[] }>('/api/shifts'),
        api.get<{ items: Employee[] }>('/api/employees'),
      ]);
      setItems(s.items);
      setEmployees(e.items);
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

  const activeCount = employees.filter((e) => e.status === 'active').length;
  const demand = useMemo(() => {
    const enabled = items.filter((s) => s.enabled === 1);
    return {
      weekday: enabled.reduce((n, s) => n + s.weekday_count, 0),
      weekend: enabled.reduce((n, s) => n + s.weekend_count, 0),
      holiday: enabled.reduce((n, s) => n + s.holiday_count, 0),
    };
  }, [items]);

  const openEdit = (row: ShiftTemplate) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      start_time: dayjs(row.start_time, 'HH:mm'),
      end_time: dayjs(row.end_time, 'HH:mm'),
      cross_day: row.cross_day === 1,
      weekday_count: row.weekday_count,
      weekend_count: row.weekend_count,
      holiday_count: row.holiday_count,
      enabled: row.enabled === 1,
      note: row.note || '',
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!editing) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.put('/api/shifts/' + editing.id, {
        name: v.name,
        start_time: v.start_time.format('HH:mm'),
        end_time: v.end_time.format('HH:mm'),
        cross_day: v.cross_day ? 1 : 0,
        weekday_count: v.weekday_count,
        weekend_count: v.weekend_count,
        holiday_count: v.holiday_count,
        enabled: v.enabled ? 1 : 0,
        note: v.note || '',
      });
      message.success('已保存班次：' + v.name);
      setOpen(false);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h2>班次模板</h2>
          <div className="sub">人数按日期类型分三档（平日 / 周末 / 法定节假日），默认三档一致，可分别调整</div>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
      </div>

      <Alert
        type={demand.weekday > activeCount ? 'warning' : 'success'}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          '每日需求人次：平日 ' +
          demand.weekday +
          ' · 周末 ' +
          demand.weekend +
          ' · 法定节假日 ' +
          demand.holiday +
          '　|　在职员工 ' +
          activeCount +
          ' 人'
        }
        description={
          demand.weekday > activeCount
            ? '注意：平日需求已超过在职人数（每人每天只能上一个班），排班时会排不开。可以调低人数或增加员工。'
            : '当前按每日需求看人数够用；员工增减或月休规则变化后，请重新生成班表。'
        }
      />

      <Card variant="outlined" styles={{ body: { padding: 0 } }}>
        <Table<ShiftTemplate>
          rowKey="id"
          loading={loading}
          dataSource={items}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: '班次',
              dataIndex: 'name',
              width: 120,
              render: (v: string, row) => (
                <Space>
                  <b>{v}</b>
                  {row.enabled === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
                </Space>
              ),
            },
            {
              title: '时间',
              key: 'time',
              width: 200,
              render: (_, row) => (
                <span>
                  {row.start_time} - {row.end_time}
                  {row.cross_day === 1 && <Tag color="purple" style={{ marginLeft: 6 }}>次日</Tag>}
                </span>
              ),
            },
            { title: '平日人数', dataIndex: 'weekday_count', width: 100, align: 'center' as const },
            { title: '周末人数', dataIndex: 'weekend_count', width: 100, align: 'center' as const },
            { title: '法定节假日人数', dataIndex: 'holiday_count', width: 140, align: 'center' as const },
            {
              title: '备注',
              dataIndex: 'note',
              ellipsis: true,
              render: (v: string | null) => v || <span className="text-muted">—</span>,
            },
            {
              title: '操作',
              key: 'action',
              width: 110,
              fixed: 'right',
              render: (_, row) => (
                <Button size="small" type="primary" ghost icon={<EditOutlined />} onClick={() => openEdit(row)}>
                  编辑
                </Button>
              ),
            },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={3}>
                <b>合计（启用中的班次）</b>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="center">
                <b>{demand.weekday}</b>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="center">
                <b>{demand.weekend}</b>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="center">
                <b>{demand.holiday}</b>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={6} colSpan={2} />
            </Table.Summary.Row>
          )}
        />
      </Card>

      <Modal
        title={editing ? '编辑班次：' + editing.name : '编辑班次'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false} initialValues={{ cross_day: false, enabled: true }}>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="name" label="班次名称" rules={[{ required: true, message: '请输入名称' }]}>
                <Input maxLength={10} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="start_time" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
                <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} needConfirm={false} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="end_time" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}>
                <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} needConfirm={false} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="cross_day" valuePropName="checked">
            <Checkbox>跨天班次（结束时间在次日）</Checkbox>
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="weekday_count" label="平日人数" rules={[{ required: true, message: '请填写' }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="weekend_count" label="周末人数" rules={[{ required: true, message: '请填写' }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="holiday_count" label="法定节假日人数" rules={[{ required: true, message: '请填写' }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>启用该班次（停用后不参与排班与需求统计）</Checkbox>
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={100} placeholder="例如：晚班单人值守需注意安全" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
