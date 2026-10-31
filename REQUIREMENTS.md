# 需求：DSH 独立长期记忆插件（dsh-deep-memory）

> 当前风险与验证边界以 [RISKS.md](RISKS.md) 为准。本文包含设计目标及历史记录，不代表所有能力均已全面验证。

> 这份文件是「拿到另一个工作区就能直接开工」的合同：目标、数据契约、接口、验收标准、已知风险。
> 配套代码已经在本目录里（`lib/`、`test/`），可以先读代码再对照本文；对不上的地方以本文为准。

---

## 0. 一句话

给 DSH 一份**按工作区隔离、会淡忘、按话题召回**的长期记忆：用户画像常驻，项目决策与踩过的坑按需注入，写过的东西不会因为压缩就消失。

**和 QQ-pet 的关系：没有关系。** 不读也不写其它项目（包括 QQ-pet）的 `bot/` 目录下的任何文件，不共享库、不共享会话、不引用那段代码。数据模型是同一套思路的重写，不是 import。

### 要直接丢给另一个工作区的话

> 在 `<新工作区>` 里实现 DSH 插件「dsh-deep-memory」。规格以本文件为准，参考实现和测试就在本仓库（**不要修改原文件**，改之前先备份）。
> 硬要求：独立数据目录 `<DSH_HOME>/deep-memory/`、两层作用域（global / workspace）、每轮注入必须走 `systemPrompt.context` 且 `interpolate:false`、写入前脱敏、所有异常静默。
> 先跑 `node --test test/`，再按第 11 节逐条验收；把「哪条过了、哪条没过、diag 里看到什么」写回本文件末尾。

---

## 1. 目标

1. 会话再长、压缩再多次，**用户明确说过的重要偏好 / 约定 / 边界**仍然记得。
2. **这个项目的决策与理由、踩过的坑、硬约束**能按话题被想起来，不需要用户重复。
3. 记忆**会淡忘**：越久、越不重要，越难被想起；但**从不自动删除**。
4. 一句话就能手动记（`remember`），也能在后台每 N 轮自动提炼一次。
5. 所有数据是**纯文本 JSON**，用户能自己打开看、自己删。

## 2. 非目标（第一版明确不做）

- 不做设置页（client 半端）。参数用 `config.json`。
- 不做向量检索 / embedding。先用 IDF + 时间衰减，够用再说。
- 不做跨机器同步、不做云。
- 不做「记忆图谱」可视化。
- 不动 DSH 自己的压缩策略；记忆提炼只是旁路，不替代压缩。
- 不做多用户隔离（DSH 是单用户桌面/本地 Web）。

---

## 3. 硬约束

| 约束 | 说明 |
| --- | --- |
| 独立工作区 | 只写 `<DSH_HOME>/deep-memory/`；不碰其它项目的 `bot/data/`、不碰其它插件目录 |
| 不改原文件 | 交付物是新目录；`bot/src/memory-v3.js` 等原文件一个字节都不改 |
| 单写者 | 记忆只由 DSH 宿主进程写；不开第二个进程写同一份库 |
| 不阻塞对话 | 注入、工具、提炼的任何异常都必须被吞掉并记 diag，绝不能让一轮对话失败 |
| 注入通道 | 每轮变化的内容必须走 `systemPrompt.context`，**不许**走 `section`（见 6.2） |
| 模板安全 | 所有注入段必须 `interpolate: false`（记忆里可能有 `{{ }}`） |
| 脱敏 | 密钥 / token / 密码在落盘前替换为 `[已隐去]` |

---

## 4. 运行环境与安装

- DSH 版本：跟随当前桌面/Web 版；插件 API 半公开（见 12 风险）。
- 安装（源码目录方式）：

```powershell
dsh plugin --profile web add "<本仓库路径>"
```

- 装完**重启一次 DSH**；设置里不需要点任何开关（默认开）。
- 卸载：`dsh plugin --profile web remove dsh-deep-memory`（数据保留在 `<DSH_HOME>/deep-memory/`）。
- 插件声明：

```js
export const name = 'deep-memory'
export const inject = ['systemPrompt', 'agents', 'timer', 'tools', 'llm']
```

---

## 5. 数据模型

两层作用域，各一个文件：

| 层 | 文件 | 放什么 | 谁可见 |
| --- | --- | --- | --- |
| global | `global.json` | 用户画像、跨项目的用户事实 | 所有会话 |
| workspace | `ws-<slug>-<hash>.json` | 项目事实、决策、坑、经历、未结束事项 | 同一 cwd 的会话 |

拿不到 cwd 时退化为 `session-<id>.json`（只给这一个会话用）。

```jsonc
{
  "version": 1,
  "scope": "global",              // 或 "ws:<slug>-<hash>"
  "profile": {
    "address": "老板",             // 称呼，≤24 字
    "style": ["先给结论"],          // ≤8 条
    "agreements": ["提交前先跑测试"],
    "boundaries": ["不要动 main"],
    "updatedAt": 0
  },
  "facts": [{
    "id": "f...",                  // 稳定唯一
    "subject": "user",             // user | project | self
    "text": "用户对芒果过敏",
    "key": "用户.忌口",             // 可选，事实键：同一个键只留最新
    "scope": "global",
    "confidence": 0.9,             // 0~1；<0.5 不参与召回
    "importance": 0.8,             // 0~1
    "tEvent": "2026-10-30",        // 事发日期，可空
    "tRecord": 0, "tConfirm": 0,   // 记录 / 最近确认
    "confirm": 1,                  // 被重复提到的次数
    "status": "current",           // current | superseded
    "sticky": false,               // true = 每轮都带（最多 2 条）
    "supersedes": "f...", "replacedBy": "f...",
    "validFrom": "2026-10-01", "validTo": ""
  }],
  "events": [{ "id": "e...", "text": "...", "scope": "...", "tEvent": "2026-10-30", "importance": 0.5, "status": "current" }],
  "pending": [{ "id": "p...", "text": "把记忆插件跑通", "state": "open", "due": "2026-11-05", "askedCount": 0 }],
  "recalls": [{ "at": 0, "query": "...", "gate": 0.4, "picked": [], "skipped": [] }],
  "meta": { "lastExtractAt": 0, "lastConsolidate": 0, "extractRuns": 0, "turns": { "sid": 3 } }
}
```

`sessions.json`：`{ "sessions": { "<sid>": { "scope": "ws:...", "cwd": "...", "at": 0 } } }`，上限 800 条，用于工具调用时找回会话对应的库。

---

## 6. 写入 / 召回 / 注入

### 6.1 写入规则

1. **事实键**：同 `key` + 同 `subject` + 同 `scope` 的 `current` 记录 → 旧记录标 `superseded`（保留，写 `validTo`/`replacedBy`），新记录写 `supersedes`/`validFrom`。
2. 同键且文本相似 > 0.9 → 不新建，`confirm++`、`tConfirm` 更新。
3. 无键：同 subject、无键、相似 > 0.72 → 视为「又提了一次」，`confirm++`；相似 < 0.95 时用新表述覆盖文本。
4. 事件：同 scope 相似 > 0.8 视为重复，丢弃。
5. 事项：同 scope、open、相似 > 0.7 → 合并，更新 `tConfirm`/`due`。
6. 每次写入前：`redactSecrets`；长度上限 事实 120 / 经历 160 / 事项 120 字。
7. **从不当场删除**；只有用户明确要求 `memory_forget` 或整理时的 `dedupe`（合并，不能保证无损保留所有差异）会减少条数。

### 6.2 召回打分

```text
rel   = 命中词的 IDF 之和 ÷ 问句里「库中出现过」的词的 IDF 之和   # 0~1
idf(t)= ln((N + 1) / (df + 0.5))                          # df+0.5 平滑：冷启动时不至于全为 0
act   = 2^(−天数 / 半衰期)，半衰期 = 30 天 × (1 + 2×重要度)
score = rel × (0.55 + 0.25×act + 0.15×重要度 + 0.05×置信度)

追问加成：问句含「上次/之前/还记得/刚才」→ act = min(1, act×1.8)
时间通道：问句含「昨天/前几天/上个月」→ 落在区间内的事实/经历 ×1.6
```

> **分母为什么只算 `df>0` 的词**（2026-10-31 修正）：`df=0` 的词库里根本没有，不可能被命中，
> 但 `idf` 公式在 `df=0` 时给的是**全库最大权重** `ln((N+1)/0.5)`。把它算进分母，等于用
> 「我们没听过这个词」去惩罚真正命中的记忆：`之前说过芒果的事` 切出 13 个词、其中 10 个库外，
> `rel` 从 1.0 被稀释到 0.104，score 0.0988 卡在 0.15 门槛下，整条记忆进不来。
> 现在只有库里出现过的词参与归一化；全库外词（`total=0`）直接 `rel=0`。

三道闸：

| 闸 | 默认 | 作用 |
| --- | --- | --- |
| `queryGate` | 0.25 | 问句信息量（IDF 归一化）不够就根本不翻库（「在吗」「继续」） |
| `minScore` | 0.15 | 单条相关度不够就不进 |
| `maxInjectChars` | 600 | 注入总字数上限，超了先不带（下次可能带） |

条数上限：事实 4 / 经历 3 / 事项 2。画像与 sticky 事实**不占**这些名额。

### 6.3 注入

- 每轮取「本会话最后一条用户消息」当查询词（跳过插件消息与本插件注入段）。
- 渲染结构：

```text
【长期记忆 · 本轮想起来的部分】
【关于用户】            ← global profile，常驻
【这个项目的约定】      ← workspace profile，常驻
【必须记得】            ← sticky 事实，最多 2 条
【项目记忆】            ← 本工作区的相关事实
【长期记忆】            ← 全局的相关事实
【共同经历】            ← 带「昨天（10-30）」这种相对+绝对日期
【还没结束的事】
（这些是长期记忆：与本轮无关的不要主动提；记不清就问，不要编。）
```

- 空库或没命中 → 返回空字符串（不追加任何消息）。
- **必须用 `agent.ctx.systemPrompt.context({ name, order: 900, interpolate: false, text: () => string })`**。
  - `section` 是拼进系统提示的：内容每轮变 → 整段缓存失效（fishmem 实测成本 0.001 → 0.02）。
  - `context` 是 DSH 给「每轮会变」的内容准备的：作为一条消息追加在末尾，内容没变不重复追加。
- 常驻提示用 `section({ name: 'deep-memory-hint', order: 89990, interpolate: false, text: () => 常量 })`，内容必须恒定。

### 6.4 工作区隔离（`.dsh-memory-off`）

某个目录不想被记忆碰，就在它的根放一个空的 `.dsh-memory-off`：

- 从 `cwd` **逐级往上**找，命中任意一层就整块关掉：不注入、不挂载、不按会话注册工具。
  这样在 `src/xxx` 子目录里开会话也躲不掉。
- 关的是**整个工作区**，包括 global 层（用户偏好）。目前没有「只关 global、保留项目记忆」的开关。
- 已在挂载的会话会被摘掉（tick 每 800ms 检查一次），`bySid` 里对应的引用一并删除。
- `diag.log` 记一行 `工作区标了 .dsh-memory-off，不挂记忆：<cwd>`（每个 sid 只记一次）。
- 插件级工具仍出现在工具表里（工具是插件注册的，不属于某个工作区），但 `memoryFor()` 返回
  `null`，调用会得到「拿不到记忆库」，不会写入任何东西。
- 删掉标记文件，下一次 tick 自动恢复。

---

## 7. 工具契约

三个工具都注册在插件级（`ctx.tools.register`），`remember` 额外按会话注册一份（`agent.ctx.tools.register`）——这是为了绕开「新会话组装工具表时看不到插件级工具」的已知行为。

### `remember`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| text | string | 是 | 一句话说清；不写密钥 |
| importance | number | 否 | 0~1，默认 0.5 |
| key | string | 否 | 事实键 `对象.方面`，不写具体值 |
| replace | string | 否 | 旧记忆片段 → 标为 superseded |
| scope | enum | 否 | `workspace`（默认）/ `global` |

输出：`{ ok: boolean, message: string }`；`render` 成功给 `✓`，失败给 `✗ 原因`。

### `memory_recall`

`{ query?, limit? }` → `{ ok, text }`；query 为空时返回最近记的 N 条（带 id）。只读。

### `memory_forget`

`{ id }` → `{ ok, message }`；按完整 id 或前缀删除一条（事实/经历/事项任意一种）。

---

## 8. 后台提炼

- 触发：`agent.ctx.on('agent/turn-stopping')` → 本会话轮次 +1；满足 `turns % extractEveryTurns === 0` 且距上次 ≥ `extractMinIntervalMs` 才跑。
- 材料：最近 30 条消息（用户/助手，跳过插件消息与注入段），总长 ≤ 6000 字。
- 模型：用**本会话当前的 provider/model**；拿不到就不跑（不猜默认模型）。
- 输出：严格 JSON；解析失败只记 diag，不重试、不打扰。
- 合并：`parseProposal` 过滤越界字段 → `applyProposal` 按 scope 路由 → 脱敏 → 保存。
- 同一会话同时只跑一次（`extracting` 集合）。
- 提炼与压缩互不替代：压缩负责「这轮之后上下文里留什么」，记忆负责「跨会话留下什么」。

---

## 9. 存储 / 并发 / 备份

- 原子写：`<file>.tmp` → `rename`（Windows 上 rename 覆盖）。
- 备份：每天首次写入前复制到 `backup/<YYYY-MM-DD>/`，保留 14 天。
- 损坏容忍：JSON 解析失败 → 从空库开始，不抛。
- 并发：单写者（宿主进程）。工具、注入、提炼都在同一进程内串行/异步，靠 `dirty` 标记合并写盘。
- 整理：每 12 小时最多一次 —— 过期事项 `open → expired`（`due < 今天`）；事实/经历超过容量 80% 时去重合并。

---

## 10. 安全与隐私

- 落盘前脱敏：`sk-…`、`ghp_…`、`AKIA…`、`xox?-…`、`Bearer …`、`api_key=…`、`password:…`。
- 设计上不应记录密钥、token、密码；提示词与格式匹配脱敏不能保证完整拦截。
- 不主动把记忆正文写进 diag；路径、会话标识与外部异常文本仍可能包含敏感信息，分享前需要检查。
- 记忆文件存储在本机 `<DSH_HOME>/deep-memory/`；自动提炼和正常对话注入会把相关内容交给宿主选择的模型服务，是否出网取决于提供商。
- ⚠ 记忆是明文 JSON：任何能读该目录的进程都能读。不要把密钥写进去（代码已经在拦，但规则仍要守）。

---

## 11. 验收清单

在另一个工作区按顺序做，每步都要有可观察结果：

1. **静态**：`node --test "test/*.test.mjs"` 全绿（5 个文件：tokenize / store / memory / extract / plugin）。
   - 注意：`node --test test/` 在 Node 24 上会报 `MODULE_NOT_FOUND`（把目录当模块入口），必须用 glob 或直接 `node --test`。
2. **装得上**：`dsh plugin --profile web add "<本目录>"` 无报错，重启后 DSH 正常启动，日志里出现 `deep-memory 已启动，库目录：…`。
3. **挂得上**：新会话里问一句，看 `<DSH_HOME>/deep-memory/diag.log` 有 `挂上记忆：<sid>`；让模型 `remember` 一条，diag 有记录。
4. **记得住**：`remember` 之后同一会话下一轮，模型能说出记下的事；杀掉会话重开（同 cwd），仍然能想起来。
5. **不串项目**：换一个 cwd 开新会话，之前项目的记忆**不出现**；全局的（用户偏好）**仍然出现**。
6. **不炸缓存**：连续两轮内容相同的注入，观察请求日志里系统提示缓存命中（不应每轮全量重算）。
7. **不破模板**：`remember` 一条含 `{{time}}` 的文本，后续轮次不报 `unknown prompt variable`。
8. **脱敏**：`remember` 一条含 `sk-` 的文本，落盘文件里是 `[已隐去]`。
9. **不重复**：同一句话 `remember` 两次，库里只有 1 条、`confirm=2`。
10. **会忘记**：把一条事实的 `importance` 设 0、`tEvent` 设两年前，问相关内容时它排到最后或进不来；但文件里还在。
11. **不阻塞**：把 `ctx.llm` 打桩成抛错，对话仍然正常（提炼静默失败，diag 有记录）。
12. **容量**：灌 400 条事实后 `remember` 不崩、注入仍在 600 字以内。

---

## 12. 已知风险 / 未验证项（重要）

1. **插件 API 不是公开稳定 API。** `systemPrompt.context/section` 返回的是 Cordis 的 effect disposer（一个**函数**，不是 `{ off() }` 对象）；`agent/inbox/inserted`、`agent/turn-stopping` 这些事件名是实测出来的。DSH 升级后可能变 → 必须保留 `try/catch` + 降级（本包已做）。
2. **胶水层已在真实 DSH 中加载验证。** 见第 14 节历史执行记录；缓存命中尚未验证，宿主升级后仍需复验。
3. **提炼质量取决于模型。** 编码会话里「什么值得记」需要按实际使用调提示词（`lib/extract.js` 的规则 1~9）。
4. **中文分词**用字 + 二字 + 英文标识符切分；没有词表。对中英混排够用，对长英文句子会有噪音（IDF 会压掉一部分）。
5. **工作区判定用 cwd**：同一目录不同机器 → 不同 `hash`（路径不同），记忆不跟随；这是有意的（不同机器上的同名目录未必是同一个项目）。

---

## 13. 交付物

```
dsh-deep-memory/
  package.json          DSH 插件清单（dsh.bundle.patch）
  cordis.patch.yml      插入 deep-memory 条目
  lib/
    index.js            插件入口：挂载、注入、工具、提炼、tick
    memory.js           分层存储 + 打分召回 + 渲染 + 整理
    extract.js          提炼提示词 / 解析 / 合并
    tokenize.js         中英混排分词
    text.js             日期、相似度、脱敏、id
    store.js            路径、原子写、备份、会话映射
    config.js           参数默认值与归一化
    hostdeps.mjs        从宿主树取 defineTool / createUserMessage
    log.js              diag
  test/                 6 个 node:test 文件、37 个用例（含 acceptance.test.mjs 的 5 条验收）
  README.md             用户视角：装、用、看、删
  HANDOFF.md            这个包做到哪、怎么接着做
  REQUIREMENTS.md       本文件
```

---

## 14. 执行记录

### 14.1 静态测试（2026-10-31）

| 命令 | 结果 |
| --- | --- |
| `node --test test/` | ✗ `MODULE_NOT_FOUND` —— Node 24 把目录参数当模块入口，不是测试路径 |
| `node --test` | ✓ 自动发现测试文件（当时 5 个文件 32 个用例） |
| `node --test "test/*.test.mjs"` | ✓ 同上（已写进 `package.json` 的 `test` 脚本） |
| 首轮 | 31 过 / 1 挂：`memory.test.mjs:73` 中文问句召回不到「芒果」 |
| 修正 `score()` 分母后 | **32 / 32 全绿** |
| 补上验收用例（`test/acceptance.test.mjs`）后 | **37 / 37 全绿**（32 单测 + 5 验收） |

修的是 `lib/memory.js` 的 `score()`：`df=0` 的库外词不再进 `rel` 的分母（原因见 6.2 的注）。

### 14.2 接口核验（对照 DSH `0.2.1-rc.2` 打包源码）

DSH 的 JS 在 `resources/app.asar` 里，用只读 asar 解析脚本取出 `@deepseek-ai/dsh-tools`、
`dsh-system-prompt`、`dsh-agent` 的源码逐条比对：

| 接口 | 本包用法 | 源码证据 | 结论 |
| --- | --- | --- | --- |
| `defineTool(options)` | `parameters` 写成「每属性一项」的 map，`required` 在属性里；`output.schema` + `output.render` | `parameterSchemaSpecToJsonSchema()` 逐属性编译并收集 required，产出 `{type:'object', properties, required}`；`options.output.schema` / `options.output.render` 必读 | ✅ 形状一致 |
| `systemPrompt.context({ name, order, interpolate, text })` | `order: 900`、`interpolate: false`、`text: () => string` | `context()` 只校验 `order` 有限；`resolveContext()` 对 `text` 为函数时传 context 调用；`renderContextSections()` 里 **`interpolate === false` 时直接取原文、不解析 `{{}}`** | ✅ 包括 `interpolate` 在内全部是真选项 |
| 返回值 | 代码同时接受「函数」和 `{off()}` | 两处都返回 *the exact Cordis effect disposer*（函数） | ✅ |
| `systemPrompt.section(...)` | `order: 89990`、文本恒定 | 同上，`renderPrompt()` 按 order 稳定排序 | ✅ |
| `agent/turn-stopping` | `agent.ctx.on('agent/turn-stopping', …)` | loop 里 `this.dispatch.serial("agent/turn-stopping", { turn, signal })`；README 明确它是 `agent/*` 可监听事件 | ✅ 事件名真实存在 |
| `ctx.agents.list()` | `tick()` 每 800ms 取活会话 | `list()` 返回 `[...store.values()].map(e => e.agent)` 的新数组 | ✅ |
| `ctx.tools.register(tool)` | 插件级 + 会话级各注册一次 | 返回 registry disposer | ✅ |

**两条疑虑已当场排除**（14.4）：`enum` 属性编译通过——三个工具带着 `enum: ['workspace','global']`
成功进了工具表；`agent.session` 的 `id` / `header.cwd` 也拿到了——4 个会话都挂上了，
且库文件按 cwd 命名成 `ws-dsh-deep-memory-*.json`。

### 14.3 12 条验收状态

| # | 验收 | 状态 | 依据 |
| --- | --- | --- | --- |
| 1 | 静态全绿 | ✅ | 37/37 |
| 2 | 装得上 | ✅ | `dsh plugin --profile desktop add` exit 0；diag 有 `deep-memory 已启动，库目录：…`；**热加载生效，没重启**。注意 profile 名是 `desktop` 不是 `web` |
| 3 | 挂得上（`挂上记忆：<sid>`） | ✅ | diag 里 4 行 `挂上记忆：session-…`；`remember` 调用返回 `✓` 并落盘 |
| 4 | 记得住（重开会话仍能想起） | ✅ | 验收用例 4：同 cwd 下新建插件实例（等效关会话重开）能召回上一会话记的事实 |
| 5 | 不串项目 | ✅ | 用例 5/5b + **重启后实测**：实跑时发现跨会话看不到 global 的 bug（已修，见 14.5）；2026-10-31 07:30 重启后，另一个工作区的会话正确答出了 global 里的「先给结论」 |
| 6 | 不炸缓存 | ⛔ **唯一没做** | 只能看宿主请求日志里的缓存命中，本包内外都没有可观测点 |
| 7 | 不破模板（`{{time}}`） | ✅ | 写入含 `{{time}}` 的记忆，下一轮注入段**原样出现**，没有 `unknown prompt variable` |
| 8 | 脱敏 | ✅ | 落盘文本为 `[已隐去]`，整份文件里搜不到 `sk-` 长串 |
| 9 | 不重复（`confirm=2`） | ✅ | 同一句 `remember` 两次 → 库里 1 条、`confirm=2` |
| 10 | 会忘记（`importance=0` + 两年前） | ✅ | 验收用例 10：那条排不到前面，但文件里仍是 2 条（不自动删） |
| 11 | 不阻塞（`ctx.llm` 打桩抛错） | ✅ | 验收用例 11：`llm.stream` 抛错时回合钩子不抛，diag 记 `提炼跳过：调用失败` |
| 12 | 容量（400 条，注入 ≤600 字） | ✅ | 验收用例 12：灌 400 条后仍能按唯一词召回、注入 ≤600 字、「在吗」仍返回空 |

> 结论：**12 条里 11 条过了，只剩 6（缓存命中）——它需要宿主请求日志，本包没有观测点。**
>
> 4/5/10/11/12 由 `test/acceptance.test.mjs` 覆盖，跑 `npm test` 会一起跑。
> 其中 4/5 是「同进程新建实例」等效模拟，不是真的杀进程重开；
> 库层和胶水层是真的，宿主生命周期那一半仍建议人工开两个会话眼看一下。

**用例 12 跑出来的一个真实行为**：400 条高度同质的事实（都含「部署/模块/注意事项」）灌进去后，
查询 `部署 注意事项 模块 mod7` 返回**空**——因为这些词在库里 df=400，`idf` 趋近 0，
问句信息量 0.0027 < `queryGate` 0.25，被闸正当挡下。换成带唯一标识的查询
（`zebrafish 回滚`）就正常命中。**这不是 bug，是信息量闸在起作用**；但它也说明：
库里同类事实太多时，问句必须带出真正的区分词，否则召回会静默变空。

### 14.4 安装与实跑记录（2026-10-31 15:16）

1. **备份**：`%USERPROFILE%\.dsh\profiles\desktop.backup-20261031-151603\`（package.json / cordis.patch.yml / pnpm-lock.yaml）。
2. **安装**：`<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add "<本仓库路径>"`
   → exit 0，`+ dsh-deep-memory 0.1.0 <- <本仓库路径>`。
   - CLI 只是 `pnpm add` 的转发（`dsh plugin [options] <pnpm args>`）。
   - 两条警告，都不是本包的问题：`cpu-features` 原生编译失败（既有依赖、缺编译器）；
     peer `@deepseek-ai/dsh-tools` / `dsh-llm` 未解析——这正是 `hostdeps.mjs` 存在的原因。
3. **自动登记**：pnpm 把依赖写成 `"dsh-deep-memory": "link:<本仓库路径>"`，
   并自动追加进 profile 的 `dsh.profile.bundles`。bundle 的 `dsh.bundle.patch`（本包的
   `cordis.patch.yml`）由加载器自己拼接，不需要手改 profile 的 patch 文件。
4. **热加载**：没有重启，下一轮起注入段和三个工具就都在了。diag：

```text
hostdeps: dsh-tools：宿主树里没有，用自己依赖里那份
hostdeps: dsh-llm：宿主树里没有，用自己依赖里那份
挂上记忆：session-bdaccc83-…
挂上记忆：session-c25e81e6-…
挂上记忆：session-a8ff212e-…
挂上记忆：session-2df51b6b-…
deep-memory 已启动，库目录：%USERPROFILE%\.dsh\deep-memory
```

5. **库文件**：`global.json` + `ws-dsh-deep-memory-0acbeccb.json` + `ws-QQ-pet-753e6e8f.json`
   + `sessions.json`，结构与第 5 节一致。
6. **实测注入段**（当轮上下文里真实出现）：

```text
【长期记忆 · 本轮想起来的部分】
【项目记忆】
- 【验收测试7】模板安全：这句里含 {{time}} 占位符，不应被宿主解析
（这些是长期记忆：与本轮无关的不要主动提；记不清就问，不要编。）
```

7. **测试数据已清理**：7/8/9 三条验证用的记忆已用 `memory_forget` 删除，`facts=0`
   （`recalls` 里留了 4 条召回轨迹，属正常历史）。

> **踩到的一个小坑**：`diag.log` 是 UTF-8 无 BOM，PowerShell 5.1 的 `Get-Content` 默认按
> ANSI(GBK) 读会显示成乱码，要看请加 `-Encoding UTF8`。文件本身没问题，记事本/VS Code 正常。

### 14.5 实跑发现并修掉的 bug：跨会话看不到全局记忆（2026-10-31 15:30）

**现象**：在 `dsh-deep-memory` 这个工作区这边 `remember` 了一条 global 事实（15:25:32 已落盘，
文件里确实有），但另一个早就开着的工作区会话被问「回复风格」时回答
「长期记忆里也没有相关条目」。

**根因**：`Memory` 是每个工作区一个实例，构造函数里各自 `new MemoryLayer(globalFile, 'global')`
把 global 层读进内存并常驻。QQ-pet 那个实例是 15:16 建的，手里是**当时的空副本**，
之后不会重读文件——所以 15:25 写进去的事实它永远看不见。

**比「读不到」更严重**：那个陈旧实例之后任何一次 `save()` 都会把空副本写回文件，
**把新写的那条抹掉**。这次侥幸没发生，只是因为它没往 global 写过东西（`dirty=false`）。

**修复**：`lib/memory.js` 里 global 层按文件路径在进程内共享一份（`sharedGlobalLayer` +
`GLOBAL_CACHE`）。一个进程内只有一个 global 对象，读写天然一致。

**回归用例**：`test/acceptance.test.mjs` 的 5b——**先**挂载 B（持有空副本），**再**让 A
写一条 global，断言 B 立刻看得到，并且 B 再写一条不会覆盖 A 的。修复前这条是红的
（B 注入为空字符串），修复后绿。

**范围**：只修同进程。真开两个 DSH 进程仍会各持一份——那在「单写者」约束之外，
要支持得按文件 mtime 重读，第一版不做。

**生效条件**：插件模块是 ESM，改文件不会热更新，**必须重启 DSH**。

**重启后实测（2026-10-31 07:30）**：diag 里出现新的
`deep-memory 已启动，库目录：…`，随后 4 个会话重新 `挂上记忆`（都是新实例、共享同一份
global）。在另一个工作区的会话里问「回复风格有什么要求」，正确答出
「先给结论，再讲理由和细节，跨项目都适用」——**跨会话可见性通过，验收 5 真过**。

### 14.6 新增：工作区隔离标记 `.dsh-memory-off`（2026-10-31）

**需求**：以后开新工作区，不想让它继承现有记忆。

**先厘清现状**：workspace 层本来就按 cwd 的哈希分文件，新目录天然是一份新库，不会串；
真正会「跟过去」的只有 global 层。所以隔离必须能连 global 一起关，否则等于没关。

**实现**：

| 位置 | 改动 |
| --- | --- |
| `lib/store.js` | `memoryDisabled(cwd)`：从 cwd 往上最多 24 级找 `.dsh-memory-off`，命中即真 |
| `lib/index.js` | `memoryFor()` 命中标记时返回 `null`；`tick()` 把已挂载的会话摘掉并清 `bySid` |
| `test/acceptance.test.mjs` | 5c（根目录标记）、5d（父目录标记 + 子目录开会话） |
| `README.md` | 新增「某个工作区不想要记忆」一节 |

**刻意没做**：config 里的 cwd 排除列表、只关 global 保留项目记忆的开关。都要改更多地方，
等真有需要再说（README「已知限制」里写明了这个边界）。

**验证**：`npm test` 40/40 全绿（含 5c/5d）。


### 14.7 上传前复查（2026-10-31）

45 项测试全绿。修复了提炼失败日志泄露正文、画像脱敏遗漏、隔离标记对已挂载会话及进行中提炼的限制、npm 包包含私人导出文件和可视化中文路径问题。具体见 HANDOFF 第 7 节。
