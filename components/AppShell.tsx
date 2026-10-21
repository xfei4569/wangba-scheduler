'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { App as AntdApp, Button, Drawer, Dropdown, Menu, Space, Tag } from 'antd';
import {
  CalendarOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MenuOutlined,
  OrderedListOutlined,
  SettingOutlined,
  TableOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api } from '@/lib/client';

const NAV = [
  { key: '/', icon: <DashboardOutlined />, label: '首页' },
  { key: '/employees', icon: <TeamOutlined />, label: '员工管理' },
  { key: '/shifts', icon: <ClockCircleOutlined />, label: '班次模板' },
  { key: '/holidays', icon: <CalendarOutlined />, label: '节假日' },
  { key: '/requirements', icon: <OrderedListOutlined />, label: '排班要求' },
  { key: '/schedule', icon: <CalendarOutlined />, label: '周排班' },
  { key: '/month', icon: <TableOutlined />, label: '月度汇总' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
];
const NAV_GROUPS = [
  { label: '准备', keys: ['/', '/employees', '/shifts', '/holidays', '/requirements'] },
  { label: '排班', keys: ['/schedule', '/month'] },
  { label: '系统', keys: ['/settings'] },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const [narrow, setNarrow] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [username, setUsername] = useState<string>('');
  const [shopName, setShopName] = useState<string>('网吧排班台');

  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < 1000);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    api
      .get<{ username: string | null }>('/api/auth/session')
      .then((d) => setUsername(d.username || ''))
      .catch(() => undefined);
    api
      .get<{ settings: Record<string, string> }>('/api/settings')
      .then((d) => {
        if (d.settings?.shop_name) setShopName(d.settings.shop_name);
      })
      .catch(() => undefined);
  }, [pathname]);

  const selected = NAV.find((n) => (n.key === '/' ? pathname === '/' : pathname.startsWith(n.key)))?.key || '/';

  const logout = async () => {
    try {
      await api.post('/api/auth/logout');
      message.success('已退出登录');
      router.push('/login');
      router.refresh();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '退出失败');
    }
  };

  const menu = (
    <Menu
      mode={narrow ? 'inline' : 'horizontal'}
      selectedKeys={[selected]}
      items={narrow
        ? NAV_GROUPS.map((group) => ({ type: 'group' as const, label: group.label,
          children: group.keys.map((key) => NAV.find((item) => item.key === key)!) }))
        : NAV}
      onClick={({ key }) => {
        setDrawerOpen(false);
        router.push(key);
      }}
      style={narrow ? { borderInlineEnd: 'none' } : undefined}
    />
  );

  return (
    <div>
      <header className="wb-app-header">
        {narrow && (
          <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} aria-label="打开菜单" />
        )}
        <div className="wb-logo">
          <span>{shopName}</span>
          <small>排班工作台</small>
        </div>
        {!narrow && <div className="wb-header-menu">{menu}</div>}
        <div className="wb-header-right" style={{ marginLeft: 'auto' }}>
          {!narrow && (
            <Tag color="blue" icon={<UserOutlined />}>
              {username || '未登录'}
            </Tag>
          )}
          <Dropdown
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录' }],
              onClick: ({ key }) => {
                if (key === 'logout') logout();
              },
            }}
          >
            <Button icon={<UserOutlined />}>{narrow ? '' : '账号'}</Button>
          </Dropdown>
        </div>
      </header>

      <Drawer
        title="导航"
        placement="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={240}
        styles={{ body: { padding: 0 } }}
      >
        {menu}
        <div style={{ padding: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <span className="text-muted">当前账号：{username || '未登录'}</span>
            <Button block danger={false} icon={<LogoutOutlined />} onClick={logout}>
              退出登录
            </Button>
          </Space>
        </div>
      </Drawer>

      <main className="wb-content">{children}</main>
    </div>
  );
}
