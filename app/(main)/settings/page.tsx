'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Input,
  InputNumber,
  Row,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CloudDownloadOutlined, LockOutlined, SaveOutlined, UnlockOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { api } from '@/lib/client';
import { formatCn } from '@/lib/date';

dayjs.extend(isoWeek);

interface SettingsResponse {
  settings: Record<string, string>;
  meta: {
    hasSensitivePin: boolean;
    sensitiveHidden: boolean;
    autoLockMinutes: number;
    dbPath: string;
    dataDir: string;
    backupDir: string;
    counts: Record<string, number>;
  };
}

interface SensitiveStatus {
  hasPin: boolean;
  unlocked: boolean;
  remainingSeconds: number;
  autoLockMinutes: number;
  hidden: boolean;
}

interface BackupItem {
  name: string;
  size: number;
  mtime: string;
  kind: 'daily' | 'manual' | 'before-update';
}

interface SessionInfo {
  username: string | null;
  usingDefaultCredentials: boolean;
  usingFallbackSecret: boolean;
}

export default function SettingsPage() {
  const { message, modal } = AntdApp.useApp();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [sensitive, setSensitive] = useState<SensitiveStatus | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [shopName, setShopName] = useState('');
  const [keep, setKeep] = useState<number>(30);
  const [dailyBackup, setDailyBackup] = useState(true);
  const [autoLock, setAutoLock] = useState<number>(10);
  const [hidden, setHidden] = useState(false);
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [allowMiddleEarly, setAllowMiddleEarly] = useState(true);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [minRest, setMinRest] = useState<number>(4);
  const [managerRest, setManagerRest] = useState<number>(2);
  const [managerNights, setManagerNights] = useState<number>(2);
  const [maxRestStreak, setMaxRestStreak] = useState<number>(3);
  const [weekStartDay, setWeekStartDay] = useState<Dayjs | null>(null);
  const [requireFemaleEarly, setRequireFemaleEarly] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, sec, sess] = await Promise.all([
        api.get<SettingsResponse>('/api/settings'),
        api.get<SensitiveStatus>('/api/sensitive'),
        api.get<SessionInfo>('/api/auth/session'),
      ]);
      setData(s);
      setSensitive(sec);
      setSession(sess);
      // 备份列表单独取：取不到（接口缺了、备份目录被锁）只影响备份那一段，别把整页弄白
      try {
        setBackups((await api.get<{ items: BackupItem[] }>('/api/backup')).items);
      } catch {
        setBackups([]);
      }
      setShopName(s.settings.shop_name || '网吧排班台');
      setKeep(Number(s.settings.backup_keep || 30));
      setDailyBackup(s.settings.daily_backup !== '0');
      setAutoLock(Number(s.settings.sensitive_auto_lock_minutes || 10));
      setHidden(s.settings.sensitive_hidden === '1');
      setAllowMiddleEarly(s.settings.scheduler_allow_middle_early !== '0');
      setWeights(Object.fromEntries(['night', 'early', 'middle', 'rest', 'field', 'streak', 'changes', 'female'].map((key) => [key, Number(s.settings['scheduler_weight_' + key] || 0)])));
      setMinRest(Number(s.settings.scheduler_min_rest_days || 4));
      setManagerRest(Number(s.settings.scheduler_manager_rest_days ?? 2));
      setManagerNights(Number(s.settings.scheduler_manager_max_nights ?? 2));
      setMaxRestStreak(Number(s.settings.scheduler_max_rest_streak ?? 3));
      const wd = Number(s.settings.scheduler_week_start_weekday || 1);
      setWeekStartDay(dayjs().subtract((dayjs().isoWeekday() - wd + 7) % 7, 'day'));
      setRequireFemaleEarly(s.settings.scheduler_require_female_early !== '0');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  const unlockSensitive = async () => {
    setBusy(true);
    try {
      await api.post('/api/sensitive', { action: 'unlock', pin });
      message.success('已解锁');
      setPin('');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '解锁失败');
    } finally {
      setBusy(false);
    }
  };

  const saveShop = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings', { shop_name: shopName });
      message.success('已保存门店名称');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const saveBackupSettings = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings', { backup_keep: keep, daily_backup: dailyBackup ? 1 : 0 });
      message.success('已保存备份设置');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const saveSensitiveSettings = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings', { sensitive_auto_lock_minutes: autoLock, sensitive_hidden: hidden ? 1 : 0 });
      message.success('已保存高级设置');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败（高级设置需要先解锁）');
    } finally {
      setBusy(false);
    }
  };

  const changePin = async () => {
    if (newPin.length < 4) {
      message.error('口令至少 4 位');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/sensitive', { action: 'set-pin', newPin });
      message.success('店长口令已更新');
      setNewPin('');
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '修改失败');
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ item: BackupItem; removed: string[] }>('/api/backup');
      message.success('已备份：' + r.item.name + (r.removed.length ? '（清理了 ' + r.removed.length + ' 个旧备份）' : ''));
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '备份失败');
    } finally {
      setBusy(false);
    }
  };

  const restore = (row: BackupItem) => {
    modal.confirm({
      title: '用这份备份还原？',
      content: '当前排班会被换成「' + row.name + '」里的内容。还原前会自动再存一份，还原错了还能换回来。',
      okText: '确认还原',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await api.put<{ restored: string; safety: string }>('/api/backup', { name: row.name });
        message.success('已还原。还原前的数据在 ' + result.safety);
        await load();
      },
    });
  };

  const saveScheduler = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings', { scheduler_allow_middle_early: allowMiddleEarly,
        scheduler_min_rest_days: minRest,
        scheduler_manager_rest_days: managerRest,
        scheduler_manager_max_nights: managerNights,
        scheduler_max_rest_streak: maxRestStreak,
        scheduler_week_start_weekday: weekStartDay ? weekStartDay.isoWeekday() : 1,
        scheduler_require_female_early: requireFemaleEarly ? 1 : 0,
        ...Object.fromEntries(Object.entries(weights).map(([k, v]) => ['scheduler_weight_' + k, v])) });
      message.success('已保存排班规则');
      await load();
    } catch (err) { message.error(err instanceof Error ? err.message : '保存失败'); }
    finally { setBusy(false); }
  };

  const fmtSize = (n: number) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');

  if (loading && !data) {
    return (
      <Card variant="outlined">
        <Spin />
      </Card>
    );
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h2>设置</h2>
          <div className="sub">账号、数据备份与高级设置</div>
        </div>
      </div>

      <Row gutter={[12, 12]}>
        <Col span={24}>
          <Card title="排班规则与评分权重" variant="outlined">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space><Switch checked={allowMiddleEarly} onChange={setAllowMiddleEarly} />允许中班后接早班（休息 8 小时）</Space>
              <Space wrap>
                <Switch checked={requireFemaleEarly} onChange={setRequireFemaleEarly} />
                <span>早班优先安排女性</span>
                <span className="text-muted">（有可用女性时至少安排 1 名；没有可用女性会提醒但不阻止排班。女性可以正常排晚班）</span>
              </Space>
              <Space wrap>
                <span>员工每月最少休息天数</span>
                <InputNumber min={2} max={10} value={minRest} onChange={(v) => setMinRest(Number(v) || 4)} style={{ width: 68 }} />
                <span className="text-muted">天（2-10，默认 4）—— 店长不算在这里；改完下次生成生效</span>
              </Space>
              <Space wrap>
                <span>店长每月最少休息天数</span>
                <InputNumber min={0} max={10} value={managerRest} onChange={(v) => setManagerRest(v == null ? 2 : Number(v))} style={{ width: 68 }} />
                <span className="text-muted">天（0-10，默认 2）—— 单独一项，不跟员工天数挂钩；0 表示这个月可以不休</span>
              </Space>
              <Space wrap>
                <span>店长每月最多夜班次数</span>
                <InputNumber min={0} max={10} value={managerNights} onChange={(v) => setManagerNights(v == null ? 2 : Number(v))} style={{ width: 68 }} />
                <span className="text-muted">次（0-10，默认 2）—— 店长要管事情，以早中班为主；0 表示完全不上夜班</span>
              </Space>
              <Space wrap>
                <span>连续休息最多</span>
                <InputNumber min={0} max={14} value={maxRestStreak} onChange={(v) => setMaxRestStreak(v == null ? 3 : Number(v))} style={{ width: 68 }} />
                <span className="text-muted">天（0-14，默认 3）—— 会自动把休息摊开；真连休超了，就在当天早班或晚班补一个人（每个班最多 3 人），并在周排班表里标红这几天；0 表示不压连休</span>
              </Space>
              <Space wrap>
                <span>一周起始日</span>
                <DatePicker value={weekStartDay} onChange={(v) => setWeekStartDay(v)} allowClear={false} style={{ width: 130 }} />
                <span className="text-muted">选个日期即可——每周从它的星期几开始（例：选 10 月 7 日周三，以后每周三到下周二算一周）。保存后现有班表自动按新周期重新分组，谁上哪天不变</span>
              </Space>
              <Collapse
                ghost
                items={[{
                  key: 'weights',
                  label: '高级调参：每条规则的分量（一般不用改）',
                  children: <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      排班时每条规则都有「分量」，数字越大越坚持这条规则，0 = 不管它。保持默认就好，想让某方面更突出再调。
                    </Typography.Text>
                    {([['night', '晚班摊平', '大家的晚班次数尽量一样多。调高 = 晚班轮得更平均；调低 = 允许有人多顶夜班。'],
                      ['rest', '月休摊平', '大家的出勤天数尽量一样多。调高 = 工时更平均。'],
                      ['early', '早班均衡', '早班次数在大家之间尽量平均。'],
                      ['middle', '中班均衡', '中班次数在大家之间尽量平均。'],
                      ['field', '内外场搭配', '两人一班时尽量一内场一外场。调高 = 更坚持搭配。'],
                      ['streak', '连上天数', '连续上班超过 5 天开始扣分。调高 = 更忌讳连着上。'],
                      ['changes', '少动老班', '重排时尽量不动上次已排好的班。调高 = 重排变化更小、更保守。'],
                      ['female', '早班女性', '早班尽量安排女性接待。调高 = 更坚持早班有女性。']] as const).map(([key, label, desc]) =>
                      <Space key={key} wrap>
                        <b style={{ display: 'inline-block', width: 66 }}>{label}</b>
                        <InputNumber min={0} max={100} value={weights[key]} onChange={(v) => setWeights((old) => ({ ...old, [key]: Number(v) || 0 }))} style={{ width: 68 }} />
                        <span className="text-muted" style={{ fontSize: 12 }}>{desc}</span>
                      </Space>)}
                  </Space>,
                }]}
              />
              <Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={saveScheduler}>保存排班规则</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="门店信息" variant="outlined">
            <Space.Compact style={{ width: '100%', maxWidth: 420 }}>
              <Input
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                maxLength={20}
                placeholder="显示在页面左上角的名称"
              />
              <Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={saveShop}>
                保存
              </Button>
            </Space.Compact>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="账号与安全" variant="outlined">
            <Descriptions column={1} size="small" colon={false}>
              <Descriptions.Item label="当前账号">{session?.username || '—'}</Descriptions.Item>
              <Descriptions.Item label="登录方式">账号密码（Cookie 会话）</Descriptions.Item>
              <Descriptions.Item label="账号密码存放位置">
                <code>项目根目录/.env</code> 里的 <code>SCHEDULER_USERNAME</code> 与 <code>SCHEDULER_PASSWORD</code>
              </Descriptions.Item>
            </Descriptions>
            {(session?.usingDefaultCredentials || session?.usingFallbackSecret) && (
              <Alert
                style={{ marginTop: 8 }}
                type="warning"
                showIcon
                message="本机配置不完整"
                description={
                  <span>
                    {session?.usingDefaultCredentials && (
                      <>
                        账号未设置，或密码少于 12 字符；
                      </>
                    )}
                    {session?.usingFallbackSecret && <>会话密钥 <code>JWT_SECRET</code> 未设置；</>}
                    请在 <code>.env</code> 中修改后重启应用。
                  </span>
                }
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <LockOutlined />
                <span>高级设置（需店长口令）</span>
                {sensitive?.unlocked ? <Tag color="green">已解锁</Tag> : <Tag>已上锁</Tag>}
              </Space>
            }
            variant="outlined"
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="这一块单独加了一道口令"
              description="前台电脑上谁都能看到屏幕，所以这里存放的个别约束记录默认不显示在排班要求页。口令与登录密码相互独立。"
            />
            {!sensitive?.hasPin ? (
              <Space.Compact style={{ width: '100%', maxWidth: 420 }}>
                <Input.Password
                  placeholder="设置店长口令（至少 4 位）"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  maxLength={32}
                />
                <Button type="primary" loading={busy} onClick={changePin}>
                  设置
                </Button>
              </Space.Compact>
            ) : !sensitive?.unlocked ? (
              <Space.Compact style={{ width: '100%', maxWidth: 420 }}>
                <Input.Password
                  placeholder="输入店长口令后解锁"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  onPressEnter={unlockSensitive}
                  maxLength={32}
                />
                <Button type="primary" icon={<UnlockOutlined />} loading={busy} onClick={unlockSensitive}>
                  解锁
                </Button>
              </Space.Compact>
            ) : (
              <>
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  <Row gutter={12} align="middle">
                    <Col span={14}>自动上锁时间（分钟）</Col>
                    <Col span={10}>
                      <InputNumber min={1} max={240} value={autoLock} onChange={(v) => setAutoLock(Number(v) || 10)} style={{ width: '100%' }} />
                    </Col>
                  </Row>
                  <Row gutter={12} align="middle">
                    <Col span={14}>
                      隐蔽模式
                      <div className="text-muted" style={{ fontSize: 12 }}>
                        开启后「高级设置」标签页从排班要求页隐藏，需要用 <code>?tab=advanced</code> 进入
                      </div>
                    </Col>
                    <Col span={10}>
                      <Switch checked={hidden} onChange={setHidden} checkedChildren="开" unCheckedChildren="关" />
                    </Col>
                  </Row>
                  <Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={saveSensitiveSettings}>
                    保存高级设置
                  </Button>
                  <Divider style={{ margin: '4px 0' }} />
                  <Space.Compact style={{ width: '100%', maxWidth: 420 }}>
                    <Input.Password
                      placeholder="修改店长口令（新口令）"
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value)}
                      maxLength={32}
                    />
                    <Button loading={busy} onClick={changePin}>
                      修改
                    </Button>
                  </Space.Compact>
                </Space>
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="数据备份" variant="outlined">
            <Space wrap style={{ marginBottom: 12 }}>
              <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy} onClick={backupNow}>
                立即备份
              </Button>
              <span className="text-muted">备份目录：{data?.meta.backupDir}</span>
            </Space>
            <Row gutter={12} align="middle" style={{ marginBottom: 12 }}>
              <Col span={10}>保留份数</Col>
              <Col span={6}>
                <InputNumber min={1} max={365} value={keep} onChange={(v) => setKeep(Number(v) || 30)} style={{ width: '100%' }} />
              </Col>
              <Col span={8}>
                <Space>
                  <Switch checked={dailyBackup} onChange={setDailyBackup} size="small" />
                  <span style={{ fontSize: 13 }}>每日首次启动自动备份</span>
                </Space>
              </Col>
            </Row>
            <Button icon={<SaveOutlined />} loading={busy} onClick={saveBackupSettings} style={{ marginBottom: 12 }}>
              保存备份设置
            </Button>
            <Table<BackupItem>
              rowKey="name"
              size="small"
              dataSource={backups}
              pagination={{ pageSize: 5, showTotal: (t) => '共 ' + t + ' 份' }}
              locale={{ emptyText: '还没有备份文件（每天第一次启动会自动生成一份）' }}
              columns={[
                {
                  title: '备份文件',
                  dataIndex: 'name',
                  render: (v: string, row) => (
                    <Space>
                      <span>{v}</span>
                      {row.kind === 'manual' ? <Tag color="blue">手动</Tag> : row.kind === 'before-update' ? <Tag color="purple">更新前</Tag> : <Tag color="green">自动</Tag>}
                    </Space>
                  ),
                },
                { title: '大小', dataIndex: 'size', width: 90, render: (v: number) => fmtSize(v) },
                {
                  title: '时间',
                  dataIndex: 'mtime',
                  width: 160,
                  render: (v: string) => new Date(v).toLocaleString('zh-CN'),
                },
                {
                  title: '',
                  width: 80,
                  render: (_: unknown, row: BackupItem) => (
                    <Button size="small" danger disabled={busy} onClick={() => restore(row)}>还原</Button>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col span={24}>
          <Card title="数据与运行信息" variant="outlined">
            <Descriptions column={2} size="small" colon={false}>
              <Descriptions.Item label="数据库文件">{data?.meta.dbPath}</Descriptions.Item>
              <Descriptions.Item label="数据目录">{data?.meta.dataDir}</Descriptions.Item>
              <Descriptions.Item label="员工记录">{data?.meta.counts.employees ?? 0} 条</Descriptions.Item>
              <Descriptions.Item label="班次模板">{data?.meta.counts.shifts ?? 0} 条</Descriptions.Item>
              <Descriptions.Item label="节假日标记">{data?.meta.counts.holidays ?? 0} 条</Descriptions.Item>
              <Descriptions.Item label="排班要求">{data?.meta.counts.requirements ?? 0} 条</Descriptions.Item>
              <Descriptions.Item label="周排班表">{data?.meta.counts.schedules ?? 0} 条</Descriptions.Item>
              <Descriptions.Item label="班次明细">{data?.meta.counts.entries ?? 0} 条</Descriptions.Item>
              <Descriptions.Item label="访问地址">
                <code>http://localhost:3899</code>
              </Descriptions.Item>
              <Descriptions.Item label="今日日期">{formatCn(new Date().toISOString().slice(0, 10))}</Descriptions.Item>
            </Descriptions>
            <Alert
              style={{ marginTop: 12 }}
              type="warning"
              showIcon
              message="备份建议"
              description="数据只有一个数据库文件。建议每周把 backup/ 里最新的备份文件发一份到自己的微信（文件传输助手），这样即使前台电脑被还原，数据也还在。"
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
