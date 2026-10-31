# DSH Deep Memory

给 DSH 会话一份**独立、分层、会淡忘**的长期记忆。

- 用户画像（称呼、偏好、约定、边界）**每轮常驻**；
- 项目里的决策、踩过的坑、硬约束**按话题召回**；
- 越久越不重要的事情慢慢想不起来，但**从不自动删除**；
- 数据是纯文本 JSON，放在 `%USERPROFILE%\.dsh\deep-memory\`，你自己能打开看。

> 这个插件是独立的：不读任何 QQ 机器人的文件、不共享记忆库、不引用那边的代码。
> 数据只在 `<DSH_HOME>/deep-memory/` 里。

---

## 装

```powershell
dsh plugin --profile desktop add "<本仓库路径>"
```

- `--profile` 按你实际在用的写：桌面端是 `desktop`，网页端一般是 `web`。**装错 profile 等于没装。**
- 装完重启一次最稳。实测本机装完不重启也会在下一轮热加载生效，但改了插件代码就必须重启。
- 默认就是开着的，不需要在设置里点任何开关。

确认装上了：

```powershell
dsh plugin --profile desktop why dsh-deep-memory
```

卸载（记忆文件保留）：

```powershell
dsh plugin --profile desktop remove dsh-deep-memory
```

---

## 用

**正常聊就行。** 每隔几轮它会在后台把值得留下的东西提炼一次；需要的时候自己会想起来。

想让它明确记住一件事：

> 记住：这个仓库提交前必须先跑 `pnpm test`。

它会调用 `remember`，安静地记下，不会在回复里说「记下了」。

想查/删：

> 你之前记过关于发布流程的什么？  → `memory_recall`
> 把那条删了。 → `memory_forget`

---

## 它记什么、不记什么

**记**：用户明确说的重要偏好、约定、边界；项目的决策与理由；踩过的坑；反复强调的做法。
**不记**：日常进度、命令输出、一次性的临时状态；密钥 / token / 密码（看到也会被替换成 `[已隐去]`）。

分两层：

| 层 | 内容 | 可见范围 |
| --- | --- | --- |
| 全局 | 你本人的偏好、称呼、跨项目约定 | 所有会话 |
| 工作区 | 某个目录下项目的决策、坑、经历、未完成事项 | 只在这个目录的会话 |

---

## 某个工作区不想要记忆

在目录根放一个空文件 `.dsh-memory-off`：

```powershell
New-Item -ItemType File "D:\临时活\某项目\.dsh-memory-off"
```

- 这个目录**以及它下面所有子目录**里开会话，都不挂记忆：不注入、不注册工具。在 `src/xxx`
  里开会话也躲不掉，不会被父目录的标记漏过去。
- 全局层也一并不注入——这是「整个工作区关掉」，不是「只关项目记忆」。想只要项目记忆、
  不要用户偏好，目前没有单独开关（见「已知限制」）。
- 跟着项目走：可以写进 `.gitignore`，也可以提交；同事没装插件的话这个文件也无害。
- 删掉文件，下一次 tick（最多约 1 秒）就恢复。
- 已经开着的会话会被摘掉；`diag.log` 里留一行 `工作区标了 .dsh-memory-off，不挂记忆：<cwd>`。

> 插件级的工具列表里仍然能看到 `remember` / `memory_recall`（工具是插件注册的，不属于某个
> 工作区），但在标记目录里调用会直接返回「拿不到记忆库」，不会写任何东西。

---

## 记忆可视化（可选）

仓库里带了一个只读前端 `viz-kit/`：把记忆库画成一片星系——重要性决定星的大小，活性决定亮度，
被取代的事实会变暗。它不含任何记忆逻辑，喂同格式的 JSON 也能画别的。

```powershell
node scripts/viz-export.mjs
```

然后双击 `viz-kit\start.cmd`（起本地服务并自动开浏览器），或手动
`node viz-kit/serve.mjs 8080` 后打开 <http://127.0.0.1:8080>。

- `viz-kit/data.json` 是**你自己的记忆导出**，已在 `.gitignore` 里，不会进仓库。
- 只监听 `127.0.0.1`；纯前端、不鉴权，别挂公网。
- 数据少的时候画面会比较空——2 条记忆就是 2 颗星。

---

## 数据在哪

```
%USERPROFILE%\.dsh\deep-memory\
  global.json              全局层
  ws-<名字>-<哈希>.json     某个工作区
  session-<id>.json        拿不到 cwd 时的退化层
  sessions.json            会话 -> 库 的映射
  config.json              可选，改参数
  backup\<日期>\            每天首次写入前的一份，留 14 天
  diag.log                 诊断（只有条数和原因，没有正文）
```

想直接看：用任何编辑器打开 `global.json` / `ws-*.json` 即可。

---

## 参数

新建 `config.json`，写你要改的字段（没写的用默认值），约 1 秒后生效：

```json
{
  "extractEveryTurns": 6,
  "maxInjectChars": 600,
  "minScore": 0.15
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | true | 总开关（关掉 = 不注入、不接工具、不提炼） |
| `extractEveryTurns` | 6 | 每多少轮后台提炼一次；0 = 只靠手记 |
| `extractMinIntervalMs` | 600000 | 两次提炼的最小间隔 |
| `maxInjectChars` | 600 | 每轮注入字数上限 |
| `kFacts` / `kEvents` / `kPending` | 4 / 3 / 2 | 每类最多注入几条 |
| `queryGate` | 0.25 | 问句信息量门槛（「在吗」这种不翻库） |
| `minScore` | 0.15 | 单条相关度门槛 |
| `halfLifeDays` | 30 | 淡忘半衰期（重要度越高淡得越慢） |
| `maxFacts` / `maxEvents` / `maxPending` | 300 / 300 / 60 | 容量（只影响还收不收，从不删） |
| `consolidateHours` | 12 | 多久整理一次（过期事项、去重） |
| `redact` | true | 写入前脱敏 |

---

## 已知限制

- 已在 DSH `0.2.1-rc.2` 上实跑（2026-10-31）：12 条验收过了 11 条，只剩「不炸缓存」没法验
  （要看宿主请求日志）。细节见 [REQUIREMENTS.md](REQUIREMENTS.md) 第 14 节。
- 分通用中文词表，靠字 + 二字 + 英文标识符切分；中英混排够用，长英文句子会有噪音。
- 没有设置页；参数只能改 JSON。
- **global 层没有按工作区关闭的开关**：`.dsh-memory-off` 是整块关掉。想「只关用户偏好、
  保留项目记忆」目前做不到，需要改代码。
- 多个 DSH 进程同时跑时，global 层各持一份，互相看不见对方新写的事实（单写者设计）。
  一个进程内没有问题。
- 不跟机器走：换机器路径变了，工作区记忆不会自动合并。

## 许可

MIT。
