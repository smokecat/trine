/**
 * 设置（方案 §4.1 / §5）：主题、发送键、prompt 片段、已知模型、新会话默认值、附件、设备信息、两级重置。
 *
 * ## 两级重置的区别必须写清楚
 *
 * - **重置本地状态**：清服务端记录、机器、时间线、游标，**保留身份**
 *   （deviceId 与密钥）。适用于「服务端库被删 / agent 重装后回复全不显示」
 *   （评审 B6 的恢复入口）——因为身份还在，agent 名册里的登记仍然有效，
 *   重新扫一次码就回来了。
 * - **忘记服务端并清除身份**：连 deviceId 与密钥一起删。这是换设备身份，
 *   agent 侧的旧登记作废，必须在 agent 上重新出配对码。
 *
 * prompt 片段、knownModels 与新会话默认模型 / 权限模式存本地 prefs（决策：
 * 片段存 client 本地；常用目录才存 agent 端）。默认值只决定新建会话 sheet 的
 * 预选；会话建好后各自的模型 / 权限由 agent 记住，改默认值不影响已有会话。
 */
import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { GripVerticalIcon, PlusIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { AppHead } from '@/components/shell/AppHead.tsx';
import { Chip, StatusDot } from '@/components/shell/StatusDot.tsx';
import {
  clickMode,
  PERMISSION_MODE_OPTIONS,
  pendingWarning,
  type ModePickerState,
} from '@/components/sheets/permission-mode.ts';
import { IS_MAC, TOUCH_QUERY, type SendKey } from '@/components/composer/composer-keys.ts';
import { useMediaQuery } from '@/components/shell/use-media-query.ts';
import { ConfirmDialog } from '@/components/machines/ConfirmDialog.tsx';
import { machineTone } from '@/components/machines/machine-text.ts';
import { useClient, useTrine } from '@/app/runtime.ts';
import { setTheme, syncFromPrefs, useTheme, type ThemeMode } from '@/app/theme.ts';
import { browserKv } from '@/lib/adapters.browser.ts';
import { KV_IDENTITY, KV_PREFS } from '@/lib/storage.ts';
import { formatBytes, truncate } from '@/lib/format.ts';
import { ATTACHMENTS_MAX_COUNT } from '@trine/core/types';
import { cn } from '@/lib/utils.ts';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

function ThemeSwitcher(): React.JSX.Element {
  const client = useClient();
  const mode = useTheme();
  const prefsTheme = useTrine((s) => s.prefs.theme);

  // client 就绪后把权威 prefs 拉过来（见 app/theme.ts 的双写说明）。
  // prefs 要到用户第一次 updatePrefs 才落盘，在那之前 store 里的
  // `theme: 'system'` 只是默认值，不能拿它覆盖本地镜像——所以先看
  // KV_PREFS 这个键到底存在没有。
  useEffect(() => {
    let persisted = false;
    try {
      persisted = localStorage.getItem(KV_PREFS) !== null;
    } catch {
      persisted = false;
    }
    syncFromPrefs(prefsTheme, persisted);
  }, [prefsTheme]);

  return (
    <div className="flex gap-1.5" data-testid="theme-switcher">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-testid={`theme-${opt.value}`}
          data-selected={mode === opt.value}
          onClick={() => setTheme(opt.value, client)}
          className={cn(
            'rounded-[10px] border px-3 py-1.5 text-[13px] transition-colors',
            mode === opt.value
              ? 'border-brand bg-brand-soft text-brand-ink font-medium'
              : 'border-border-strong bg-surface text-text-2 hover:text-text',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** 常用 prompt 片段：增、删、上下移（顺序即 composer 菜单里的顺序） */
function PromptSnippets(): React.JSX.Element {
  const client = useClient();
  const snippets = useTrine((s) => s.prefs.promptSnippets);
  const [draft, setDraft] = useState('');

  const save = (next: string[]): void => client?.updatePrefs({ promptSnippets: next });
  const move = (index: number, delta: number): void => {
    const next = [...snippets];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    save(next);
  };

  return (
    <section className="flex flex-col gap-2" data-testid="prompt-snippets">
      <h2 className="font-medium">常用 prompt 片段</h2>
      <p className="text-text-3 text-xs">
        存在本设备（不同步到 agent）。在聊天输入框打 <code className="font-mono">/</code> 时可以选用。
      </p>
      <ul className="flex flex-col gap-1.5">
        {snippets.map((text, i) => (
          <li key={`${i}-${text.slice(0, 12)}`} className="flex items-center gap-1">
            <span className="border-border bg-surface-2 min-w-0 flex-1 truncate rounded-[10px] border px-2.5 py-1.5 text-xs">
              {truncate(text, 60)}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              title="上移"
              aria-label="上移"
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <GripVerticalIcon className="rotate-90" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="删除"
              aria-label="删除片段"
              data-testid="snippet-remove"
              onClick={() => save(snippets.filter((_, j) => j !== i))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
        {snippets.length === 0 && <li className="text-text-3 text-xs">还没有片段。</li>}
      </ul>
      <div className="flex gap-1.5">
        <Textarea
          data-testid="snippet-input"
          className="min-h-9 flex-1 text-xs"
          rows={1}
          placeholder="例如：先读代码再动手，改完跑 bun test"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="snippet-add"
          disabled={draft.trim() === ''}
          onClick={() => {
            save([...snippets, draft.trim()]);
            setDraft('');
          }}
        >
          <PlusIcon />
          添加
        </Button>
      </div>
    </section>
  );
}

/** 已知模型列表：新建会话 / 会话设置里的候选 chips */
function KnownModels(): React.JSX.Element {
  const client = useClient();
  const models = useTrine((s) => s.prefs.knownModels);
  const [draft, setDraft] = useState('');
  const save = (next: string[]): void => client?.updatePrefs({ knownModels: next });

  return (
    <section className="flex flex-col gap-2" data-testid="known-models">
      <h2 className="font-medium">已知模型</h2>
      <p className="text-text-3 text-xs">
        模型选择的候选。用家族别名（如 opus、opus[1m]）会自动指向该家族最新版本，模型升级后不用改。
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {models.map((m) => (
          <li
            key={m}
            className="border-border bg-surface-2 flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 font-mono text-[11.5px]"
          >
            {m}
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-5"
              title="移除"
              aria-label={`移除 ${m}`}
              onClick={() => save(models.filter((x) => x !== m))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
        {models.length === 0 && <li className="text-text-3 text-xs">列表为空，新建会话时自由输入即可。</li>}
      </ul>
      <div className="flex gap-1.5">
        <Input
          data-testid="model-input"
          className="h-8 font-mono text-xs"
          placeholder="opus[1m]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="model-add"
          disabled={draft.trim() === '' || models.includes(draft.trim())}
          onClick={() => {
            save([...models, draft.trim()]);
            setDraft('');
          }}
        >
          <PlusIcon />
          添加
        </Button>
      </div>
    </section>
  );
}

/** 发送键：只管 PC（实体键盘）；触屏设备回车永远换行，见 composer-keys.ts */
function SendKeySetting(): React.JSX.Element {
  const client = useClient();
  const sendKey = useTrine((s) => s.prefs.sendKey);
  const touch = useMediaQuery(TOUCH_QUERY);
  const mod = IS_MAC ? '⌘' : 'Ctrl';
  const options: { value: SendKey; label: string }[] = [
    { value: 'enter', label: 'Enter 发送 · Shift+Enter 换行' },
    { value: 'mod-enter', label: `${mod}+Enter 发送 · Enter 换行` },
  ];

  return (
    <section className="flex flex-col gap-2" data-testid="send-key-setting">
      <h2 className="font-medium">发送键</h2>
      <p className="text-text-3 text-xs">
        电脑键盘上的发送方式。手机、平板等触屏设备上回车总是换行，点发送按钮发送
        {touch ? '（本设备即触屏设备）' : ''}。
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <Chip
            key={opt.value}
            data-testid={`send-key-${opt.value}`}
            selected={sendKey === opt.value}
            onClick={() => client?.updatePrefs({ sendKey: opt.value })}
          >
            {opt.label}
          </Chip>
        ))}
      </div>
    </section>
  );
}

const COMPRESS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '不压缩' },
  { value: 1, label: '超过 1 MB' },
  { value: 2, label: '超过 2 MB' },
  { value: 5, label: '超过 5 MB' },
  { value: 10, label: '超过 10 MB' },
];

/** 附件：每条消息的个数 / 合计上限，图片压缩阈值 */
function AttachmentSettings(): React.JSX.Element {
  const client = useClient();
  const maxCount = useTrine((s) => s.prefs.attachMaxCount);
  const maxTotalMb = useTrine((s) => s.prefs.attachMaxTotalMb);
  const compressMb = useTrine((s) => s.prefs.imageCompressMb);
  const [relayMax, setRelayMax] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    client?.blobConfig().then(
      (c) => {
        if (alive) setRelayMax(c.maxBytes);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [client]);

  return (
    <section className="flex flex-col gap-2" data-testid="attachment-settings">
      <h2 className="font-medium">附件</h2>
      <p className="text-text-3 text-xs">
        每条消息能带的图片 / 文件。附件加密后经服务端中转（只存密文，默认保留 7 天），过期后点开时由 agent 重新上传。
        {relayMax !== null && ` 服务端单个附件上限 ${formatBytes(relayMax)}。`}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <NumberSetting
          label="最多个数"
          testId="attach-max-count"
          value={maxCount}
          min={1}
          max={ATTACHMENTS_MAX_COUNT}
          integer
          onCommit={(v) => client?.updatePrefs({ attachMaxCount: v })}
        />
        <NumberSetting
          label="合计上限（MB）"
          testId="attach-max-total"
          value={maxTotalMb}
          min={1}
          max={4096}
          onCommit={(v) => client?.updatePrefs({ attachMaxTotalMb: v })}
        />
      </div>
      <div className="text-text-3 text-[11px] tracking-[0.05em] uppercase">图片压缩</div>
      <p className="text-text-3 text-xs">
        超过阈值的图片先在浏览器里缩到长边 2000px 再上传，省流量也更快；不压缩时大图由 agent 交给 Claude 自己读取缩放。
      </p>
      <div className="flex flex-wrap gap-1.5">
        {COMPRESS_OPTIONS.map((opt) => (
          <Chip
            key={opt.value}
            data-testid={`compress-${opt.value}`}
            selected={compressMb === opt.value}
            onClick={() => client?.updatePrefs({ imageCompressMb: opt.value })}
          >
            {opt.label}
          </Chip>
        ))}
      </div>
    </section>
  );
}

/** 数字设置项：失焦或回车时校验并提交，非法值还原 */
function NumberSetting({
  label,
  testId,
  value,
  min,
  max,
  integer = false,
  onCommit,
}: {
  label: string;
  testId: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Number(text);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      toast.error(`${label}需要是 ${min}–${max} 之间的${integer ? '整数' : '数'}`);
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <label className="flex items-center gap-2">
      <span className="text-text-2 text-xs">{label}</span>
      <Input
        data-testid={testId}
        inputMode="numeric"
        className="h-8 w-20"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

/** 新会话默认值：新建会话 sheet 预选的模型与权限模式 */
function SessionDefaults(): React.JSX.Element {
  const client = useClient();
  const models = useTrine((s) => s.prefs.knownModels);
  const defaultModel = useTrine((s) => s.prefs.defaultModel);
  const defaultMode = useTrine((s) => s.prefs.defaultPermissionMode);
  const [draft, setDraft] = useState('');
  // 选 bypass 作为默认值同样两击确认（同一个状态机，见 permission-mode.ts）
  const [pending, setPending] = useState<ModePickerState['pending']>(null);
  const modeState: ModePickerState = { value: defaultMode, pending };
  const chips = models.includes(defaultModel) ? models : [...models, defaultModel];

  const applyDraft = (): void => {
    if (draft.trim() === '') return;
    client?.updatePrefs({ defaultModel: draft.trim() });
    setDraft('');
  };

  return (
    <section className="flex flex-col gap-2" data-testid="session-defaults">
      <h2 className="font-medium">新会话默认值</h2>
      <p className="text-text-3 text-xs">新建会话时预选的模型与权限模式。已有会话各自记住自己的设置，不受影响。</p>
      <div className="text-text-3 text-[11px] tracking-[0.05em] uppercase">模型</div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((m) => (
          <Chip
            key={m}
            data-testid="default-model"
            selected={defaultModel === m}
            onClick={() => client?.updatePrefs({ defaultModel: m })}
            className="font-mono"
          >
            {m}
          </Chip>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          className="h-8 font-mono text-xs"
          placeholder="自定义模型名"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            applyDraft();
          }}
        />
        <Button size="sm" variant="outline" type="button" disabled={draft.trim() === ''} onClick={applyDraft}>
          使用
        </Button>
      </div>
      <div className="text-text-3 mt-1 text-[11px] tracking-[0.05em] uppercase">权限模式</div>
      <div className="flex flex-wrap gap-1.5">
        {PERMISSION_MODE_OPTIONS.map((opt) => {
          const danger = pending === opt.value;
          return (
            <Chip
              key={opt.value}
              data-testid="default-mode"
              data-mode={opt.value}
              data-pending={String(danger)}
              selected={defaultMode === opt.value}
              className={cn(danger && 'border-red bg-red-soft text-red font-medium')}
              onClick={() => {
                const next = clickMode(modeState, opt.value);
                setPending(next.pending);
                if (next.pending === null && next.value !== defaultMode) {
                  client?.updatePrefs({ defaultPermissionMode: next.value });
                }
              }}
            >
              {opt.label}
            </Chip>
          );
        })}
      </div>
      {pendingWarning(modeState) !== '' && (
        <p className="text-red text-[11.5px]">{pendingWarning(modeState)}</p>
      )}
    </section>
  );
}

export function SettingsView(): React.JSX.Element {
  const client = useClient();
  const navigate = useNavigate();
  const serverUrl = useTrine((s) => s.serverUrl);
  const connection = useTrine((s) => s.connection);
  const leader = useTrine((s) => s.leader);
  const machines = useTrine((s) => s.machines);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);

  // 公钥指纹前 8 位：核对「两端说的是同一个设备」时用，够区分且不占地方
  const fingerprint = client?.publicKeys.box.slice(0, 8) ?? '—';

  return (
    <>
      <AppHead back="/" title="设置" />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 text-sm">
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">主题</h2>
          <ThemeSwitcher />
        </section>

        <Separator />
        <SendKeySetting />

        <Separator />
        <PromptSnippets />

        <Separator />
        <KnownModels />

        <Separator />
        <SessionDefaults />

        <Separator />
        <AttachmentSettings />

        <Separator />

        <section className="flex flex-col gap-2">
          <h2 className="font-medium">本设备</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-text-3">设备 id</dt>
            <dd className="font-mono text-xs break-all" data-testid="device-id">
              {client?.deviceId ?? '—'}
            </dd>
            <dt className="text-text-3">公钥指纹</dt>
            <dd className="font-mono text-xs break-all">{fingerprint}</dd>
            <dt className="text-text-3">服务端</dt>
            <dd className="font-mono text-xs break-all">{serverUrl ?? '（未配对）'}</dd>
            <dt className="text-text-3">连接</dt>
            <dd>
              {connection.status}
              {connection.lastCloseCode !== null && ` · 上次关闭码 ${connection.lastCloseCode}`}
            </dd>
            <dt className="text-text-3">标签页</dt>
            <dd className="text-xs">
              {leader.state} · {leader.mode === 'locks' ? 'Web Locks' : '心跳选举（无 Web Locks）'}
            </dd>
            <dt className="text-text-3">构建</dt>
            <dd className="font-mono text-xs">
              {import.meta.env.MODE}
              {import.meta.env.DEV ? ' · dev server' : ''}
            </dd>
          </dl>
        </section>

        <Separator />

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">机器</h2>
            <Button size="sm" variant="ghost" asChild>
              <NavLink to="/machines">全部 →</NavLink>
            </Button>
          </div>
          <ul className="flex flex-col gap-1">
            {Object.values(machines).map((m) => (
              <li key={m.machineId}>
                <NavLink
                  to={`/machines/${m.machineId}`}
                  className="border-border hover:border-border-strong flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors"
                >
                  <StatusDot tone={machineTone(m.online)} />
                  <span className="font-mono">{m.name}</span>
                </NavLink>
              </li>
            ))}
            {Object.keys(machines).length === 0 && (
              <li className="text-text-3 text-xs">还没有配对任何机器。</li>
            )}
          </ul>
        </section>

        <Separator />

        <section className="border-red/40 flex flex-col gap-3 rounded-[14px] border p-3">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-red font-medium">重置本地状态</h2>
            <p className="text-text-3 text-xs">
              清除服务端记录、全部机器与时间线、游标；<strong>保留设备身份</strong>
              （deviceId 与密钥），所以 agent 侧的登记仍然有效——重新扫一次码就能把机器加回来。
              适用于：服务端库被删 / agent 重装后「回复全部不显示」。
            </p>
            <Button
              variant="destructive"
              className="w-fit"
              data-testid="reset-local"
              onClick={() => setConfirmReset(true)}
            >
              重置本地状态…
            </Button>
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5">
            <h2 className="text-red font-medium">忘记服务端并清除身份</h2>
            <p className="text-text-3 text-xs">
              连 deviceId 与密钥一起删除，等于换一台新设备。
              <strong>agent 侧的旧登记随之作废</strong>，必须在每台机器上重新出配对码。
              只有在身份损坏或要把本浏览器彻底清干净时才用。
            </p>
            <Button
              variant="destructive"
              className="w-fit"
              data-testid="wipe-identity"
              onClick={() => setConfirmWipe(true)}
            >
              清除身份…
            </Button>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        testId="confirm-reset-local"
        busy={busy}
        title="重置本地状态？"
        description={
          <>
            <p>本设备保存的机器、会话历史与同步游标会被清空，无法恢复。</p>
            <p>设备身份保留，重新扫码即可把机器加回来。</p>
          </>
        }
        confirmLabel="确认重置"
        onConfirm={() => {
          setBusy(true);
          void client
            ?.resetLocalState()
            .then(() => {
              toast.success('已重置本地状态');
              navigate('/pair');
            })
            .finally(() => {
              setBusy(false);
              setConfirmReset(false);
            });
        }}
      />

      <ConfirmDialog
        open={confirmWipe}
        onOpenChange={setConfirmWipe}
        testId="confirm-wipe"
        busy={busy}
        title="清除身份并忘记服务端？"
        description={
          <>
            <p>deviceId、密钥、全部机器与历史都会删除，无法恢复。</p>
            <p>
              <strong>每台机器都需要重新出配对码重配</strong>
              ——agent 侧对旧身份的登记会作废。
            </p>
            <p>完成后页面会重新加载。</p>
          </>
        }
        confirmLabel="清除身份"
        onConfirm={() => {
          setBusy(true);
          void (async () => {
            try {
              await client?.resetLocalState();
              // identity 没有对应的 client API（它刻意不提供——换身份是极端操作），
              // 这里直接删 KV 键，随后整页重载让 runtime 重新生成一份
              browserKv().kv.remove(KV_IDENTITY);
            } finally {
              window.location.href = '/pair';
            }
          })();
        }}
      />
    </>
  );
}
