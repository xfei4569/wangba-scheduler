'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, App as AntdApp, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { api } from '@/lib/client';

interface SessionInfo {
  loggedIn: boolean;
  username: string | null;
  usingDefaultCredentials: boolean;
  usingFallbackSecret: boolean;
}

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    api
      .get<SessionInfo>('/api/auth/session')
      .then(setSession)
      .catch(() => undefined);
  }, []);

  const submit = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError('');
    try {
      await api.post('/api/auth/login', values);
      message.success('登录成功');
      const next = params.get('next');
      router.push(next && next.startsWith('/') ? next : '/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="wb-login-wrap">
      <Card className="wb-login-card" variant="outlined">
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            网吧排班台
          </Typography.Title>
          <Typography.Text type="secondary">店长专用 · 请使用账号密码登录</Typography.Text>
        </div>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        {(session?.usingDefaultCredentials || session?.usingFallbackSecret) && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="本机登录配置未完成"
            description={
              <span>
                请先在终端运行 npm run setup；或在 .env 中配置自己的账号、至少 12 字符的密码和至少 32 字符的签名密钥，再重启。
              </span>
            }
          />
        )}

        <Form layout="vertical" onFinish={submit} autoComplete="off" requiredMark={false}>
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input size="large" prefix={<UserOutlined />} placeholder="登录账号" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="登录密码" onPressEnter={() => undefined} />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            登录
          </Button>
        </Form>

        <div style={{ marginTop: 16, color: '#8c8c8c', fontSize: 12, lineHeight: 1.8 }}>
          · 账号密码在项目根目录的 <code>.env</code> 中配置（SCHEDULER_USERNAME / SCHEDULER_PASSWORD）
          <br />· 本系统只在前台电脑本机使用，不对外开放网络访问
        </div>
      </Card>
    </div>
  );
}
