'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Space } from 'antd';
import { CloudDownloadOutlined } from '@ant-design/icons';
import { api } from '@/lib/client';
import { mondayOf, todayStr } from '@/lib/date';

interface BackupItem {
  name: string;
  size: number;
  mtime: string;
  kind: 'daily' | 'manual';
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (iso: string) => {
  const d = new Date(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const localTime = (iso: string) => {
  const d = new Date(iso);
  return localDate(iso) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};

/** 本周还没备份过就提醒一次（首页 / 周工作台共用） */
export default function BackupReminder({ style }: { style?: React.CSSProperties }) {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<BackupItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ items: BackupItem[] }>('/api/backup');
      setItems(data.items);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const weekStart = mondayOf(todayStr());
  const latest = items && items.length
    ? items.reduce((a, b) => (new Date(a.mtime).getTime() >= new Date(b.mtime).getTime() ? a : b))
    : null;
  const backedUpThisWeek = Boolean(latest && localDate(latest.mtime) >= weekStart);
  if (items === null || backedUpThisWeek) return null;

  const backupNow = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ item: BackupItem }>('/api/backup');
      message.success('已备份：' + result.item.name);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '备份失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12, ...style }}
      message="本周还没有备份过数据库"
      description={
        latest
          ? '最近一次备份：' + localTime(latest.mtime) + '（' + latest.name + '）。建议每周把 backup/ 里最新的一份发到微信「文件传输助手」，万一电脑被还原，数据还在。'
          : 'backup/ 目录还是空的。点右侧按钮立刻备份一份；平时每天首次启动也会自动备份。'
      }
      action={
        <Space>
          <Button size="small" type="primary" icon={<CloudDownloadOutlined />} loading={busy} onClick={backupNow}>
            立即备份
          </Button>
        </Space>
      }
    />
  );
}
