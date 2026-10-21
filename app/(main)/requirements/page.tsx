'use client';

import { useEffect, useState } from 'react';
import { Alert, App as AntdApp, Card, Result, Spin, Tabs, type TabsProps } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { api } from '@/lib/client';
import type { Employee, ShiftTemplate } from '@/lib/types';
import LeavePanel from '@/components/req/LeavePanel';
import AvoidPanel from '@/components/req/AvoidPanel';
import ExtraPanel from '@/components/req/ExtraPanel';
import AdvancedPanel from '@/components/req/AdvancedPanel';

interface SensitiveStatus {
  hasPin: boolean;
  unlocked: boolean;
  hidden: boolean;
}

export default function RequirementsPage() {
  const { message } = AntdApp.useApp();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<ShiftTemplate[]>([]);
  const [sensitive, setSensitive] = useState<SensitiveStatus | null>(null);
  const [activeKey, setActiveKey] = useState('leave');
  const [revealAdvanced, setRevealAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [e, s, sec] = await Promise.all([
        api.get<{ items: Employee[] }>('/api/employees'),
        api.get<{ items: ShiftTemplate[] }>('/api/shifts'),
        api.get<SensitiveStatus>('/api/sensitive'),
      ]);
      setEmployees(e.items);
      setShifts(s.items);
      setSensitive(sec);
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

  // 隐蔽模式下的进入方式：地址栏带 ?tab=advanced，或双击页面标题
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'advanced') {
      setRevealAdvanced(true);
      setActiveKey('advanced');
    }
  }, []);

  const showAdvanced = revealAdvanced || Boolean(sensitive?.unlocked) || !sensitive?.hidden;

  const items: NonNullable<TabsProps['items']> = [
    { key: 'leave', label: '请假登记', children: <LeavePanel employees={employees} /> },
    { key: 'avoid', label: '避班', children: <AvoidPanel employees={employees} shifts={shifts} /> },
    { key: 'extra', label: '临时加派', children: <ExtraPanel shifts={shifts} /> },
  ];
  if (showAdvanced) {
    items.push({
      key: 'advanced',
      label: (
        <span>
          <LockOutlined style={{ marginRight: 4 }} />
          高级设置
        </span>
      ),
      children: <AdvancedPanel employees={employees} />,
    });
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h2
            onDoubleClick={() => {
              setRevealAdvanced(true);
            }}
            title=""
          >
            排班要求
          </h2>
          <div className="sub">先录入请假、避班和临时人数，生成班表时会自动遵守</div>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这些要求会影响后续排班"
        description="请假和避班用于限制人员，临时加派用于调整某天某班的人数；已有草稿不会自动改变，保存后请回到周排班重新计算。"
      />

      {loading ? (
        <Card variant="outlined">
          <Spin />
        </Card>
      ) : employees.length === 0 ? (
        <Card variant="outlined">
          <Result
            status="warning"
            title="还没有员工"
            subTitle="排班要求需要先有员工。请先到「员工管理」把店里的人录进去。"
          />
        </Card>
      ) : (
        <Tabs activeKey={activeKey} onChange={setActiveKey} items={items} destroyInactiveTabPane={false} />
      )}
    </>
  );
}
