'use client';

import { useEffect, useMemo, useState } from 'react';
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
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/lib/client';
import {
  EMPLOYEE_GENDERS,
  EMPLOYEE_POSITIONS,
  EMPLOYEE_SENIORITIES,
  EMPLOYEE_STATUS_LABEL,
  EMPLOYEE_TAGS,
  isMentor,
  isNewbie,
  type Employee,
  type EmployeeStatus,
} from '@/lib/types';
import { formatCn } from '@/lib/date';

const STATUS_COLOR: Record<EmployeeStatus, string> = {
  active: 'green',
  leave: 'orange',
  resigned: 'default',
};

interface FormValues {
  name: string;
  tags?: string[];
  status: EmployeeStatus;
  gender?: string;
  seniority?: string;
  can_teach?: boolean;
  position?: string;
  hire_date?: dayjs.Dayjs | null;
  leave_date?: dayjs.Dayjs | null;
  note?: string;
}

export default function EmployeesPage() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [items, setItems] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.get<{ items: Employee[] }>('/api/employees');
      setItems(d.items);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载员工失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () =>
      items.filter(
        (e) => (!keyword || e.name.includes(keyword)) && (!statusFilter || e.status === statusFilter)
      ),
    [items, keyword, statusFilter]
  );

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: 'active', tags: [], gender: '', seniority: '老人', can_teach: true, position: '员工', hire_date: dayjs(), leave_date: null });
    setOpen(true);
  };

  const openEdit = (row: Employee) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      tags: row.tags,
      status: row.status,
      gender: row.gender || '',
      seniority: row.seniority || '老人',
      can_teach: row.can_teach === 1,
      position: row.position || '员工',
      hire_date: row.hire_date ? dayjs(row.hire_date) : null,
      leave_date: row.leave_date ? dayjs(row.leave_date) : null,
      note: row.note || '',
    });
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const payload = {
      name: values.name,
      tags: values.tags || [],
      status: values.status,
      gender: values.gender || '',
      seniority: values.seniority || '老人',
      can_teach: values.can_teach ? 1 : 0,
      position: values.position || '员工',
      hire_date: values.hire_date ? values.hire_date.format('YYYY-MM-DD') : null,
      leave_date: values.leave_date ? values.leave_date.format('YYYY-MM-DD') : null,
      note: values.note || '',
    };
    setSaving(true);
    try {
      if (editing) {
        await api.put('/api/employees/' + editing.id, payload);
        message.success('已保存：' + payload.name);
      } else {
        await api.post('/api/employees', payload);
        message.success('已新增员工：' + payload.name);
      }
      setOpen(false);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: Employee) => {
    try {
      const r = await api.del<{ removed_requirements: number }>('/api/employees/' + row.id);
      message.success('已删除：' + row.name + (r.removed_requirements ? '（同时清理了 ' + r.removed_requirements + ' 条排班要求）' : ''));
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const counts = useMemo(() => {
    const c = { active: 0, leave: 0, resigned: 0 };
    for (const e of items) c[e.status] += 1;
    return c;
  }, [items]);

  return (
    <>
      <div className="page-title">
        <div>
          <h2>员工管理</h2>
          <div className="sub">
            共 {items.length} 人 · 在职 {counts.active} · 暂停排班 {counts.leave} · 离职 {counts.resigned}
            （女性 {items.filter((e) => e.status === 'active' && e.gender === '女').length} 人 ·
            新人 {items.filter((e) => e.status === 'active' && isNewbie(e)).length} 人 ·
            店长 {items.filter((e) => e.status === 'active' && e.position === '店长').length} 人；
            人数可随时增减，重新排班会按最新在职名单执行）
          </div>
        </div>
        <Space wrap>
          <Input
            placeholder="搜索姓名"
            allowClear
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 160 }}
          />
          <Select
            placeholder="全部状态"
            allowClear
            style={{ width: 130 }}
            value={statusFilter || undefined}
            onChange={(v) => setStatusFilter(v || '')}
            options={Object.entries(EMPLOYEE_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增员工
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="员工人数随时可增减"
        description="新增员工后即可参与后续排班；长期离开请改为「离职」，短期请假请到「排班要求」登记日期。删除会让历史班次失去姓名，建议谨慎使用。"
      />

      <Card variant="outlined" styles={{ body: { padding: 0 } }}>
        <Table<Employee>
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => '共 ' + t + ' 人' }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '还没有员工，点右上角「新增员工」开始' }}
          columns={[
            { title: '姓名', dataIndex: 'name', fixed: 'left', width: 120, render: (v: string) => <b>{v}</b> },
            {
              title: '标签',
              dataIndex: 'tags',
              width: 150,
              render: (tags: string[]) =>
                tags && tags.length ? (
                  <Space size={4} wrap>
                    {tags.map((t) => (
                      <Tag key={t} color={t === '内场' ? 'geekblue' : 'cyan'}>
                        {t}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <span className="text-muted">未标注</span>
                ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (s: EmployeeStatus) => <Tag color={STATUS_COLOR[s]}>{EMPLOYEE_STATUS_LABEL[s]}</Tag>,
            },
            {
              title: '性别 / 经验 / 职位',
              key: 'profile',
              width: 220,
              render: (_: unknown, row: Employee) => (
                <Space size={4} wrap>
                  {row.position === '店长' && <Tag color="gold">店长</Tag>}
                  {row.gender ? <Tag color={row.gender === '女' ? 'magenta' : 'blue'}>{row.gender}</Tag> : <Tag>未填写</Tag>}
                  {isNewbie(row) ? <Tag color="cyan">新人</Tag> : <Tag>老人</Tag>}
                  {isMentor(row) ? <Tag color="green">可带教</Tag> : <Tag>不带教</Tag>}
                </Space>
              ),
            },
            { title: '入职日期', dataIndex: 'hire_date', width: 130, render: (v: string | null) => formatCn(v) },
            { title: '离职日期', dataIndex: 'leave_date', width: 130, render: (v: string | null) => formatCn(v) },
            { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string | null) => v || <span className="text-muted">—</span> },
            {
              title: '操作',
              key: 'action',
              width: 150,
              fixed: 'right',
              render: (_, row) => (
                <Space>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="确认删除这位员工？"
                    description="只有从未排过班的员工可以删除；删除也会清掉其排班要求。已有班次请改为「离职」。"
                    okText="确认删除"
                    cancelText="取消"
                    onConfirm={() => remove(row)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={editing ? '编辑员工：' + editing.name : '新增员工'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={520}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
                <Input placeholder="例如：小王" maxLength={16} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="状态" tooltip="暂停排班会一直不参与排班，没有起止日期。请几天假请到「排班要求」登记" rules={[{ required: true, message: '请选择状态' }]}>
                <Select
                  options={Object.entries(EMPLOYEE_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="gender" label="性别" tooltip="用于早班女性接待偏好；留空表示未填写，不会被计为女性">
                <Select allowClear placeholder="未填写" options={[{ value: '', label: '未填写' }, ...EMPLOYEE_GENDERS.map((g) => ({ value: g, label: g }))]} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="seniority" label="经验" tooltip="新人必须与至少 1 名可带教者同班">
                <Select options={EMPLOYEE_SENIORITIES.map((s) => ({ value: s, label: s }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="position" label="职位" tooltip="店长始终视为可带教，可多个也可以没有">
                <Select options={EMPLOYEE_POSITIONS.map((p) => ({ value: p, label: p }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="can_teach" valuePropName="checked" tooltip="关掉后他不会作为新人的带教者（店长不受此开关影响）">
            <Checkbox>可带教（默认老人可带教）</Checkbox>
          </Form.Item>
          <Form.Item name="tags" label="标签（可多选，用于同班时内外场搭配参考）">
            <Select
              mode="multiple"
              allowClear
              placeholder="内场 / 外场"
              options={EMPLOYEE_TAGS.map((t) => ({ value: t, label: t }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="hire_date" label="入职日期">
                <DatePicker style={{ width: '100%' }} placeholder="选择日期" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="leave_date" label="离职日期">
                <DatePicker style={{ width: '100%' }} placeholder="离职时填写" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={200} showCount placeholder="例如：熟悉收银、住附近" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
