# 扩展（extensions）

扩展让 trine 在会话界面里显示别的工具的数据、提供操作按钮，而 trine 本身不认识任何具体工具。
典型用法：在会话页看本项目的任务列表、当前会话关联的任务状态，一键开新会话接续某个任务。

本文是扩展契约（apiVersion 1）与作者指南。协议帧见 [PROTOCOL-REQUIREMENTS.md](PROTOCOL-REQUIREMENTS.md#31-扩展agent--0160)，
设计取舍见 [DECISIONS.md](DECISIONS.md) D18。

## 工作方式

```text
浏览器 ──（E2E）── agent ── 扩展进程（一次调用一个进程）
  只渲染数据          跑扩展、校验输出、
  点击后提交 token     执行动作
```

- **扩展跑在 agent 机器上**，是一个外部程序：stdin 收一个 JSON，stdout 回一个 JSON。用什么语言写都行。
- **浏览器不执行扩展的任何代码。** 扩展只能返回下面「视图词汇」里的数据，由 trine 用自己的组件渲染。
- **读取永远没有副作用。** 显示、刷新、推送视图都不会执行任何动作。动作只在用户点击后执行。

## 信任边界

- 安装扩展等于信任它的代码：它以 agent 的系统用户身份运行，能读写这个用户能读写的文件。
  trine 不提供沙箱。扩展只能在 agent 机器上用命令行安装，浏览器不能安装。
- trine 管的是扩展能**让 trine 做什么**（插入文字、发消息、开会话、改关联、回调扩展自己），
  按扩展、按能力设置权限（见[权限](#权限)）。
- 扩展返回的文字一律当不可信数据：标题等字段按纯文本显示；详情的 Markdown 不渲染任何图片、
  不渲染 raw HTML，链接只保留 https。
- 扩展进程只拿到会话的元信息（id、标题、状态、目录、关联），拿不到对话内容。

## 安装与调试

```bash
trine-agent ext validate ./my-extension      # 只校验 manifest 与入口，不运行
trine-agent ext add ./my-extension           # 注册；agent 在运行时立即生效
trine-agent ext list
trine-agent ext test my-ext view --cwd ~/project   # 用合成上下文跑一次，打印规范化输出
trine-agent ext test my-ext action --args '{"actionId":"archive"}' --allow-write
trine-agent ext test my-ext view --features files.open   # 模拟新 web 声明的特性
trine-agent ext reload my-ext                # 扩展升级后重读 manifest
trine-agent ext remove my-ext                # 它写下的会话关联保留
```

都支持 `--home DIR`。注册表在 `<home>/extensions.json`；启用、停用和权限在网页的「设置 → 扩展」里改，
对这台机器的所有设备生效。

## manifest

扩展目录里的 `trine-extension.json`：

```json
{
  "apiVersion": 1,
  "id": "tasks",
  "name": "任务",
  "version": "0.2.0",
  "description": "可选，一句话说明",
  "entry": ["bin/trine-ext"],
  "contributes": {
    "sessionPanel":   { "title": "任务", "icon": "list-checks" },
    "sessionBadge":   true,
    "linkPicker":     { "title": "关联任务", "multiple": true },
    "composerAction": { "label": "任务" },
    "newSession":     { "title": "从任务开始" }
  },
  "capabilities": ["prompt.insert", "prompt.send", "session.create", "links.write", "invoke"]
}
```

- `id`：小写字母、数字、连字符，2–32 个字符。`trine` 保留给 trine 自己的时间线记录（如 agent 重启），不能注册。
- `entry`：argv 数组，不经过 shell。`entry[0]` 是相对路径（含 `/` 或以 `.` 开头）时**按扩展目录解析**，
  是裸命令名（如 `python3`）时在 PATH 里找；之后的参数里，相对路径（以 `./`、`../` 开头或含 `/`，如 `bin/run`）也按扩展目录解析，不含 `/` 的参数原样传。
  入口不会按会话目录解析。
- `contributes`：放到界面的哪些位置，见[贡献点](#贡献点)。
- `capabilities`：扩展可能请求的能力。没声明的一律被拒。`copy`、`refresh` 没有副作用，不用声明。

## 调用约定

agent 执行 `<entry...> <op>`，op 是 `view`、`badge`、`pick`、`action` 之一。

- stdin：一个 JSON（写完即关闭），上限 256 KB。
- stdout：一个 JSON，上限 512 KB。退出码非 0 或不是合法 JSON 都算失败。
- 工作目录：会话的目录（工作区面板时是工作区目录）。只当作数据上下文，扩展自己的文件用
  `TRINE_EXT_DIR`（扩展目录）定位。
- 超时：读取 5 秒，action 30 秒。超时后整个进程组先收到 SIGTERM，2 秒后 SIGKILL。
- 环境变量只给白名单：`HOME`、`USER`、`LOGNAME`、`LANG`、`LC_*`、`TZ`、`TMPDIR`、`SHELL`、`TERM`、
  `PATH`（去掉空段、`.` 和相对段），以及 `TRINE_EXT_API=1`、`TRINE_EXT_DIR`。
- 并发：每个扩展最多同时 2 个进程，全部扩展最多 4 个；用户的操作排在刷新前面。
- 读取结果在 agent 上缓存 15 秒；动作完成、关联变化、扩展配置变化时作废。

输入：

```json
{
  "apiVersion": 1,
  "op": "view",
  "point": "sessionPanel",
  "locale": "zh-CN",
  "context": {
    "machine": { "id": "…", "name": "…" },
    "cwd": "/path/to/project",
    "session": { "id": "…", "title": "…", "state": "idle", "cwd": "/path/to/project",
                 "archived": false, "links": [{ "ref": "task-a", "label": "Task A" }] },
    "linkedSessions": [{ "id": "…", "title": "…", "state": "idle", "cwd": "…",
                         "archived": false, "links": [{ "ref": "…", "label": "…" }] }],
    "features": ["files.open"]
  },
  "args": {}
}
```

- `features`：这次调用里能用的宿主特性，见[特性协商](#特性协商)。旧 agent 不带这个字段，按空数组处理。
- `session.links`、`linkedSessions` 里只有**本扩展**的关联。`linkedSessions` 是这台机器上带本扩展关联的会话
  （最多 200 个，不限目录），扩展可以据此显示「这个任务关联了哪些会话」。
- `newSession` 的 `pick` 没有 `session`，`cwd` 是用户在新建会话 sheet 里选的目录。
- `args`：`pick` 可能带 `{ "query": "…" }`；`action` 带 `{ "actionId", "itemId", "params", "invocationId" }`。

各 op 的输出：

| op | 输出 |
|---|---|
| `view` | `{ "view": View }` |
| `badge` | `{ "badge": Badge \| null, "links"?: [{ "ref", "label" }] }`（`links` 可刷新已有关联的显示名） |
| `pick` | `{ "items": PickItem[] }` |
| `action` | `{ "ok"?: true, "message"?: "…", "effects"?: Effect[], "view"?: View }` |
| 任意 | 出错时 `{ "error": { "code": "…", "message": "…" } }`，message 会显示给用户 |

## 视图词汇

```ts
View     = { title?, sections: Section[], toolbar?: Action[], empty?: string }
Section  = { id, title?, collapsed?: boolean, items: Item[], empty?: string }
Item     = { id, title, subtitle?, badges?: Badge[], meta?: string,
             detail?: string,                 // 受限 Markdown
             link?: { ref, label },           // 可关联；有它才显示关联开关
             sessions?: string[],             // 会话 id，显示成可跳转的会话引用
             actions?: Action[] }
Badge    = { text, tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger', title? }
Action   = { id, label, primary?, destructive?, confirm?: string,
             effects?: Effect[]               // 与 invoke 二选一
             invoke?: { params?: object,      // 回调扩展的 action op
                        requires?: string[] } } // 回调返回的效果会用到的特性（见特性协商）
PickItem = { id, title, subtitle?, badges?, link?: { ref, label }, effects?: Effect[] }
Effect   = { type: 'prompt.insert', text }                        // 插入输入框（本设备执行）
         | { type: 'copy', text }                                 // 复制（本设备执行）
         | { type: 'refresh' }                                    // 刷新视图（本设备执行）
         | { type: 'files.open', path, dir?: boolean }            // 打开文件 / 浏览目录（本设备执行，需特性协商）
         | { type: 'prompt.send', text }                          // 发给当前会话（agent 执行）
         | { type: 'session.create', prompt, cwd?, title?, links? } // 新建会话并发送（agent 执行）
         | { type: 'links.add', links: { ref, label }[] }         // agent 执行
         | { type: 'links.remove', refs: string[] }               // agent 执行
```

- 上限：sections 20、每组 items 200、每项 actions 8、每个动作 effects 4、pick items 500；
  普通文本 2 KB，detail 16 KB，prompt 32 KB。超限或出现未知的 effect 类型时整个输出判为无效，
  面板显示「扩展返回了无法识别的内容」。
- `session.create` 只能指定目录、标题、首条消息和关联；模型和权限模式用发起设备的「新会话默认值」。
  注意默认值可能是 bypass，确认弹窗会醒目标出。
- 指向会话的效果（`prompt.send`、`links.*`）只在会话面板里可用。
- `ref` 是扩展自己定义的字符串，要在扩展的数据里保持稳定（归档、改名不变）。
- `files.open`（agent 与 web 都较新时）：在会话的文件查看里打开 `path`（`dir: true` 时浏览目录）。
  工作区展开时进工作区，否则开文件抽屉；执行时扩展面板会先关上。`path` 建议给绝对路径
  （相对路径按会话目录解析），最长 4096 字符，不能含 NUL。
  - 不新增权限能力、不用在 manifest 里声明：能不能看仍由 agent 的文件查看决定（会话目录、信任目录、
    密钥类文件始终不可见）。路径在范围外时，目录会显示「不在可浏览范围内」与信任入口，文件会给
    「浏览所在目录」，**是否信任由用户决定，扩展不能让 trine 自动信任任何目录**。
  - 结果回来时用户已经换到别的会话，这个动作的本地效果整条不执行（不打开到另一个会话里，同一动作里的插入也不做）。
  - 范围外的文件给的是**所在目录**：相对路径按会话目录、`~/` 按 agent 的 home 解析成绝对路径。
  - 一个动作里有多个 `files.open` 时只执行最后一个。

## 特性协商

有些效果只有新版本的 web 会执行（目前只有 `files.open`）。为了不让旧 web 收到它不认识的内容
（旧 web 会把整份视图判为无效），这类效果要经过协商：

1. agent 在 `machine.info.extensions.features` 里列出自己支持的特性。web 在 `ext.read`（读取、订阅与
   每次续租）和 `ext.action.prepare` 里声明自己能执行、且 agent 列出了的特性，并带上页面实例 id。
2. agent 取 **web 声明 ∩ agent 支持 ∩ 贡献点能执行** 作为有效特性集，缺省为空。
   `files.open` 只在会话内的 `sessionPanel` 能执行；`workspacePanel`（没有会话）、`composerAction`、
   `newSession`、`linkPicker` 一律不含。web 不在会话页、或 agent 不支持文件查看时也不声明。
3. 有效特性集随读取、订阅、动作令牌保存（点击时再与发起设备此刻的声明取交集，只会收窄），
   并作为输入里的 `context.features` 传给扩展；`invoke` 的 `action` op 拿到的是令牌里的那一份。
   读取缓存的键包含输入，所以不同特性集的结果互不复用；应答也带回有效集，web 按它分开缓存，
   特性集变化时不会拿旧特性集下的动作来显示。
4. agent 在输出边界检查：视图 / 候选项里**用到有效集之外特性的整个动作**不下发（不会拆开只留一部分）。
   这不依赖扩展自觉。web 执行本地动作前再按本页的处理器检查一遍整个动作，缺了就整条不执行并提示。
5. 同一台设备换了页面实例（另一个标签页、或旧版页面接管）时，agent 作废旧实例的订阅和令牌，
   带特性的在途结果也不再投递给它（动作结果去掉本地效果和新视图）。

`invoke` 型动作的效果要等扩展跑完才知道，所以分两种情况：

- **事先声明**：在动作的 `invoke.requires` 里列出这次回调会用到的特性（如 `["files.open"]`）。
  有效集里缺任何一项，动作在视图里就不给，prepare 也会在**启动扩展进程之前**拒绝，不会产生副作用。
  推荐这样写。
- **执行之后才发现**：扩展返回的效果用到了有效集之外的特性时，这些效果**全部丢弃**（一个都不执行），
  但扩展自己的操作已经发生了。结果按成功返回并带 `effectsDropped: true`，提示写明「已执行，后续效果
  当前页面不支持、已丢弃，没有回滚，请勿直接重试」。扩展的 action 本来就应当按 `invocationId` 幂等，
  但用户再点一次是新的 `invocationId`，所以不要让需要 `files.open` 的回调依赖这条兜底。

兼容：

| 组合 | 结果 |
|---|---|
| 新 web + 新 agent，会话面板 | `context.features` 含 `files.open`，动作可用 |
| 旧 web（不声明） | 空集，带 `files.open` 的动作被过滤，旧 web 永远收不到 |
| 旧 agent | `machine.info` 不列 `features`，web 不声明；它也不认识 `files.open`，扩展若照样输出会被判为无效 |
| 旧扩展（不看 `features`） | 照常工作；它本来就不会输出 `files.open` |

扩展的写法：只在 `context.features` 含 `files.open` 时才输出这类动作，旧 agent / 旧 web 下保持原样。
用 `trine-agent ext test ID view --features files.open` 可以模拟新 web 的声明。

## 贡献点

| 贡献点 | 位置 | op |
|---|---|---|
| `sessionPanel` | 会话页头部的扩展按钮 → 面板（桌面右侧抽屉，手机底部 sheet） | `view` |
| `sessionBadge` | 会话页头部按钮上的徽章（会话有本扩展的关联时）；会话列表行上另显示关联名（不调用扩展） | `badge` |
| `linkPicker` | 会话「⋯」菜单与列表右键菜单的「关联…」，支持多选与批量 | `pick` |
| `workspacePanel` | 会话列表按工作区分组时，组头「⋯」→「扩展面板…」：不进会话也能看、能开新会话（没有输入框，插入类动作改为复制） | `view` |
| `composerAction` | 输入框的扩展按钮（桌面在工具栏 prompt 按钮旁，手机在「+」托盘里），在片段面板的位置列出候选项；只允许 `prompt.insert` 与 `links.add` | `pick` |
| `newSession` | 新建会话 sheet 里的「从…开始」（agent 0.17.0 起）：上下文是 sheet 里选中的目录，没有会话。选一项后，它的 `prompt.insert` 文字预填为首条消息（用户可以改），`link` 在会话建好后自动关联。只允许 `prompt.insert`；既没有 `prompt.insert` 也没有 `link` 的项不可选 | `pick` |

## 动作的执行

- 只含本地效果（`prompt.insert`、`copy`、`refresh`、`files.open`）的动作，由点击的设备直接执行。
- 其他动作在网页上只是一个一次性的令牌：只对拿到它的设备有效，10 分钟过期，agent 重启、扩展 reload、
  停用或改权限后作废。点击后 agent 按令牌里固定的效果生成执行计划：
  - 需要确认时把计划发给用户。确认弹窗显示的就是将要执行的内容（完整的消息、目录、目标会话、模型、权限模式），
    确认后不会重新运行扩展、不会改变内容；
  - 执行前再检查一次：目标会话还在、目录和权限模式没变、扩展没变。变了就要求重新操作。
- `invoke` 型动作需要确认时，在启动扩展进程**之前**确认；扩展返回的效果同样按权限和贡献点检查，
  需要确认的会再弹一次。
- 同一次点击（invocationId）只执行一次。网页没等到结果时会提示「结果未知」，不会自动重试。
  写数据的 action 应把 `args.invocationId` 当作幂等键，或保证重复执行无害。

## 权限

在「设置 → 扩展」里按扩展设置，对这台机器的全部设备生效：

| 能力 | 默认 |
|---|---|
| 读取、`copy`、`refresh`、`files.open` | 总是允许（`files.open` 受文件查看的范围限制） |
| `prompt.insert` | 允许 |
| `links.write`（扩展动作改关联） | 允许 |
| `invoke`（扩展自己的操作） | 允许；扩展标了 `destructive` 或 `confirm` 的动作要确认 |
| `prompt.send`、`session.create` | 每次确认 |

- **自定义**：每项可选允许、每次确认、禁止。
- **全托管**：扩展声明的能力全部允许，点击后直接执行、不弹任何确认，包括扩展升级后新声明的能力。
- 用户在 trine 界面上手动关联 / 取消关联（「关联…」、面板里的关联开关）是本人操作，不受扩展权限约束。

## 会话关联

会话可以挂多条关联 `{ ext, ref, label }`，存在 agent 的 `<home>/session-links.json`，随会话元数据同步到所有设备。
来源：用户手动关联、扩展的 `links.*` 与 `session.create` 效果，或新建会话时从 `newSession` 候选项开始。
归档不清，永久删除会话时清掉；移除扩展时保留。

## 时间线记录

扩展相关的操作会在会话时间线留一条记录（agent 0.17.0 起），所有设备都看得到，扩展不用为此做任何事：

- 关联增删（不论来源）：「Tasks · 已关联 Task A」「Tasks · 已取消关联 Task A」；
- 会话面板里 `invoke` 型动作成功：「Tasks · 归档 · Task A：已归档」，依次是动作名、条目标题、action 输出的 `message`。

`prompt.send` 不另记（消息本身就在时间线里），工作区面板的动作没有会话、不记。记录存在 agent 的
`<home>/session-ext-records.json`，每会话保留最近 50 条，永久删除会话时清掉；不写进 Claude 的会话转录。

## 最小示例

```sh
#!/bin/sh
# bin/trine-ext：只提供一个会话面板
cat >/dev/null   # 不需要输入也要读完 stdin
case "$1" in
  view)
    echo '{"view":{"sections":[{"id":"s","items":[{"id":"hello","title":"Hello",
      "actions":[{"id":"ins","label":"插入问候","effects":[{"type":"prompt.insert","text":"你好"}]}]}]}]}}'
    ;;
  *) echo '{"error":{"code":"unsupported","message":"不支持"}}' ;;
esac
```
