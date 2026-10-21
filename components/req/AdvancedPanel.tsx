'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Form,
  Input,
  Popconfirm,
  Result,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import { DeleteOutlined, LockOutlined, PlusOutlined, ReloadOutlined, UnlockOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/lib/client';
import type { Employee, Requirement } from '@/lib/types';
import { formatRangeCn } from '@/lib/date';

interface SensitiveStatus {
  hasPin: boolean;
  unlocked: boolean;
  remainingSeconds: number;
  autoLockMinutes: number;
  hidden: boolean;
}

interface Values {
  employee_id: number;
  employee_id_2: number;
  long_term: boolean;
  range?: [dayjs.Dayjs, dayjs.Dayjs];
  note?: string;
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

export default function AdvancedPanel({ employees }: { employees: Employee[] }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<Values>();
  const [status, setStatus] = useState<SensitiveStatus | null>(null);
  const [items, setItems] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [masked, setMasked] = useState(true);
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPin2, setNewPin2] = useState('');
  const longTerm = Form.useWatch('long_term', form);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.get<SensitiveStatus>('/api/sensitive'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败');
    }
  }, [message]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ items: Requirement[] }>('/api/requirements?type=pairing');
      setItems(d.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status?.unlocked) loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.unlocked]);

  // 解锁倒计时
  useEffect(() => {
    if (!status?.unlocked) return;
    const timer = setInterval(() => {
      setStatus((s) => {
        if (!s) return s;
        const left = s.remainingSeconds - 1;
        if (left <= 0) {
          return { ...s, unlocked: false, remainingSeconds: 0 };
        }
        return { ...s, remainingSeconds: left };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.unlocked]);

  const unlock = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ autoLockMinutes: number }>('/api/sensitive', { action: 'unlock', pin });
      message.success('已解锁，' + r.autoLockMinutes + ' 分钟后自动上锁');
      setPin('');
      await loadStatus();
      await loadItems();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '解锁失败');
    } finally {
      setBusy(false);
    }
  };

  const lockNow = async () => {
    await api.post('/api/sensitive', { action: 'lock' });
    message.success('已上锁');
    setItems([]);
    await loadStatus();
  };

  const setPinFirst = async () => {
    if (newPin.length < 4) {
      message.error('口令至少 4 位');
      return;
    }
    if (newPin !== newPin2) {
      message.error('两次输入的口令不一致');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/sensitive', { action: 'set-pin', newPin });
      message.success('店长口令已设置，本区域已解锁');
      setNewPin('');
      setNewPin2('');
      await loadStatus();
      await loadItems();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '设置失败');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (values: Values) => {
    if (!values.long_term && !values.range) {
      message.error('请选择日期区间，或勾选「长期有效」');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/requirements', {
        type: 'pairing',
        employee_id: values.employee_id,
        employee_id_2: values.employee_id_2,
        long_term: values.long_term ? 1 : 0,
        date_start: values.long_term ? null : values.range?.[0].format('YYYY-MM-DD'),
        date_end: values.long_term ? null : values.range?.[1].format('YYYY-MM-DD'),
        note: values.note || '',
      });
      message.success('已保存');
      form.resetFields(['note']);
      await loadItems();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Requirement) => {
    try {
      await api.del('/api/requirements/' + row.id);
      message.success('已删除');
      await loadItems();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  if (!status) {
    return (
      <Card variant="outlined">
        <Result status="info" title="正在检查加密状态…" />
      </Card>
    );
  }

  // ① 还没设置口令
  if (!status.hasPin) {
    return (
      <Card title="首次使用：设置店长口令" variant="outlined">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="这个区域默认是锁着的"
          description="前台电脑上没有登录账号的人也能看到屏幕，所以本区域单独加了一道口令。口令至少 4 位，只用于打开本区域，与登录密码无关。"
        />
        <Row gutter={12} style={{ maxWidth: 560 }}>
          <Col span={12}>
            <Input.Password
              placeholder="设置新口令（至少 4 位）"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              maxLength={32}
            />
          </Col>
          <Col span={12}>
            <Input.Password
              placeholder="再输一次"
              value={newPin2}
              onChange={(e) => setNewPin2(e.target.value)}
              maxLength={32}
              onPressEnter={setPinFirst}
            />
          </Col>
        </Row>
        <Button type="primary" className="mt-12" loading={busy} icon={<LockOutlined />} onClick={setPinFirst}>
          设置口令并进入
        </Button>
      </Card>
    );
  }

  // ② 已设口令但未解锁
  if (!status.unlocked) {
    return (
      <Card variant="outlined">
        <Result
          icon={<LockOutlined style={{ color: '#8c8c8c' }} />}
          title="该区域已加密"
          subTitle={'仅店长可见。请输入店长口令解锁；离开前台前请点「立即上锁」，或等待自动上锁（当前 ' + status.autoLockMinutes + ' 分钟）。'}
          extra={
            <Space>
              <Input.Password
                placeholder="店长口令"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                onPressEnter={unlock}
                style={{ width: 200 }}
                maxLength={32}
              />
              <Button type="primary" loading={busy} icon={<UnlockOutlined />} onClick={unlock}>
                解锁
              </Button>
            </Space>
          }
        />
      </Card>
    );
  }

  // ③ 已解锁
  const maskedName = (idx: number, name?: string | null) =>
    masked ? '员工' + (CIRCLED[idx] || '·') : name || '—';

  return (
    <>
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <Space wrap>
            <span>已解锁</span>
            <span className="text-muted">剩余 {Math.max(0, status.remainingSeconds)} 秒后自动上锁</span>
            <Switch
              checkedChildren="显示姓名"
              unCheckedChildren="隐藏姓名"
              checked={!masked}
              onChange={(v) => setMasked(!v)}
            />
            <Button size="small" icon={<LockOutlined />} onClick={lockNow}>
              立即上锁
            </Button>
          </Space>
        }
        description="列表默认隐藏姓名，避免路过的人看到；需要核对时再打开「显示姓名」。"
      />

      <Card title="组合避让记录" variant="outlined" size="small" className="mb-12">
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ long_term: true }}>
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item name="employee_id" label="员工一" rules={[{ required: true, message: '请选择' }]}>
                <Select
                  placeholder="选择员工"
                  showSearch
                  optionFilterProp="label"
                  options={employees.filter((e) => e.status !== 'resigned').map((e) => ({ value: e.id, label: e.name }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item name="employee_id_2" label="员工二" rules={[{ required: true, message: '请选择' }]}>
                <Select
                  placeholder="选择员工"
                  showSearch
                  optionFilterProp="label"
                  options={employees.filter((e) => e.status !== 'resigned').map((e) => ({ value: e.id, label: e.name }))}
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
            <Col xs={24} md={5}>
              <Form.Item name="long_term" valuePropName="checked" label=" ">
                <Checkbox>长期有效</Checkbox>
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12} align="bottom">
            <Col xs={24} md={12}>
              <Form.Item name="note" label="备注（仅本区域可见）">
                <Input placeholder="选填" maxLength={60} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label=" ">
                <Space>
                  <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={busy}>
                    保存
                  </Button>
                  <Button onClick={() => form.resetFields()}>重置</Button>
                </Space>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <Card
        title={'组合避让记录（' + items.length + ' 条）'}
        variant="outlined"
        size="small"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={loadItems}>
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
          locale={{ emptyText: '还没有记录' }}
          columns={[
            {
              title: '编号',
              key: 'idx',
              width: 70,
              render: (_: unknown, __: Requirement, index: number) => '#' + (index + 1),
            },
            {
              title: '员工一',
              key: 'a',
              width: 140,
              render: (_: unknown, row: Requirement, index: number) => maskedName(index, row.employee_name),
            },
            {
              title: '员工二',
              key: 'b',
              width: 140,
              render: (_: unknown, row: Requirement, index: number) => maskedName(index, row.employee_name_2),
            },
            {
              title: '有效期',
              key: 'period',
              width: 240,
              render: (_: unknown, row: Requirement) =>
                row.long_term === 1 ? <Tag color="purple">长期有效</Tag> : formatRangeCn(row.date_start, row.date_end),
            },
            {
              title: '备注',
              dataIndex: 'note',
              ellipsis: true,
              render: (v: string | null) => (masked ? <span className="text-muted">已隐藏</span> : v || <span className="text-muted">—</span>),
            },
            {
              title: '操作',
              key: 'action',
              width: 90,
              render: (_: unknown, row: Requirement) => (
                <Popconfirm title="删除这条记录？" okText="删除" cancelText="取消" onConfirm={() => remove(row)}>
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
