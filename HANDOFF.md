# HANDOFF · dsh-deep-memory

> 给下一个接手的人 / AI：这里说清楚**做到了哪一步、什么验证过、什么没验证、从哪接着做**。
> 需求合同在 [REQUIREMENTS.md](REQUIREMENTS.md)，用户视角在 [README.md](README.md)。

---

## 1. 这个包是什么

一套**独立**的 DSH 长期记忆插件：两层存储（global / workspace）、事实键 + supersede、
pending 生命周期、时间衰减、IDF 召回、三道闸、预算注入；三个工具；每轮注入走
`systemPrompt.context`（不毁缓存），常驻提示走 `systemPrompt.section`（内容恒定）；
每 N 轮在后台用**当前会话的模型**提炼一次。

**没有** import `bot/` 里任何东西，**没有**修改任何原文件。所有交付物都在 `dsh-deep-memory/` 下。

---

## 2. 已完成

| 项 | 状态 |
| --- | --- |
| 数据模型（两层、事实键、双时间、pending、sticky、recalls） | 写完 |
| 召回打分（IDF + 衰减 + 追问加成 + 时间通道 + 三道闸 + 预算） | 写完 |
| 渲染（画像常驻 / 项目 / 全局 / 经历 / 事项 / 页脚） | 写完 |
| 提炼（提示词、容错解析、按 scope 合并、脱敏） | 写完 |
| 插件胶水（挂载、注入、工具、回合钩子、tick、卸载） | 写完；**已在真实宿主跑起来**（2026-10-31，见 3） |
| hostdeps（宿主树取 defineTool / createUserMessage，带本地兜底） | 写完 |
| 存储（原子写、备份、损坏容忍、会话映射） | 写完 |
| 测试（tokenize / store / memory / extract / plugin） | **45/45 全绿**（含上传前回归检查） |
| 文档（README / REQUIREMENTS / HANDOFF） | 写完 |

---

## 3. 验证状态（必须知道的实话）

**最新上传前检查：45 个用例全绿。** 下文保留开发过程中的历史测试记录。

```powershell
cd <本仓库路径>
node --test "test/*.test.mjs"     # 或 npm test
```

上一版交接里「本机 shell 坏了、一条命令都没跑起来」在这台机器上**不成立**：
`pwsh 5.1.26100.9711` + `node v24.15.0` 正常。两个发现：

1. 原写法 `node --test test/` 在 Node 24 上必挂 —— 它把 `test/` 当模块入口，报
   `MODULE_NOT_FOUND`。已改成 glob，并写进 `package.json` 的 `test` 脚本。
2. 首轮 31 过 1 挂（`memory.test.mjs:73` 中文问句召回不到「芒果」）。根因是**打分公式**，
   不是阈值：`df=0` 的库外词拿到了全库最大 idf（`ln((N+1)/0.5)`），13 个词里 10 个库外时
   把 `rel` 从 1.0 稀释到 0.104。现在只有库里出现过的词进分母。详见 REQUIREMENTS 6.2 的注。

**插件已经装进 DSH 并真的跑起来了**（2026-10-31 15:16，profile `desktop`）：

- `dsh plugin --profile desktop add "<本仓库路径>"` exit 0，pnpm 自动把它写进
  `dsh.profile.bundles`；bundle 的 `cordis.patch.yml` 由加载器自己拼，不用手改 profile。
- **没有重启就生效了**：下一轮起系统提示里有 `【长期记忆】` 常驻段，注入段
  `【长期记忆 · 本轮想起来的部分】` 出现，工具表里有 `remember` / `memory_recall` / `memory_forget`。
- diag 有 `挂上记忆：session-…` ×4 和 `deep-memory 已启动，库目录：…`。
- 实跑验证过：脱敏（`sk-` → `[已隐去]`）、去重（同句两次 `confirm=2` 只 1 条）、
  模板安全（含 `{{time}}` 的记忆原样注入、没有 `unknown prompt variable`）。

前面担心的三处接口（`defineTool` 参数形状、`systemPrompt.context` 返回值、
`agent/turn-stopping` 事件名）现在**既在 DSH 源码里核过，也在活宿主里跑过了**，
详见 REQUIREMENTS 14.2 / 14.4。

**还没验证的只剩 1 条**：缓存命中（第 6 条）——要看宿主请求日志里的 system prompt cache 命中，
本包内外都没有观测点。其余 11 条全过了，其中 4/5/10/11/12 由
`test/acceptance.test.mjs` 覆盖（`npm test` 一起跑，37 个用例全绿）。

⚠ 4/5 是「同进程新建插件实例」等效模拟，不是真的杀进程重开。库层和胶水层是真的，
宿主生命周期那一半仍建议人工开两个会话眼看一下。

**接手第一件事**：人工补一次「关掉会话重开」和「换 cwd 开新会话」，然后就可以真用起来了。

---

## 4. 装到 DSH 之后的验证顺序

按 [REQUIREMENTS.md 第 11 节](REQUIREMENTS.md) 走。最短路径：

1. 装、重启，看 `diag.log` 有没有 `deep-memory 已启动，库目录：…`。
2. 开一个会话，说一句「记住：这个项目用 pnpm」，看 `diag.log` 有没有 `挂上记忆：<sid>`，以及 `ws-*.json` 里是否有那条事实。
3. 同一会话下一轮问「这个项目用什么包管理器」，看它能不能说出来。
4. 换一个 cwd 开新会话，确认**项目记忆不串**、**用户偏好还在**。
5. `remember` 一条带 `{{time}}` 的文本，确认之后几轮不报 `unknown prompt variable`。
6. 把 `lib/index.js` 里的 `askModel` 临时打桩抛错，确认对话不受影响。

---

## 5. 代码地图（改哪里）

| 想做 | 改 |
| --- | --- |
| 调「什么值得记」 | `lib/extract.js` 的 `buildPrompt` 规则 1~9 |
| 调召回手感 | `lib/memory.js` 的 `score` / `recall` / `render`；参数在 `lib/config.js` |
| 加分词 | `lib/tokenize.js` |
| 换注入位置/通道 | `lib/index.js` 的 `mountFor` |
| 工具参数/说明 | `lib/index.js` 的 `rememberTool` / `recallTool` / `forgetTool` |
| 加设置页 | 需要新写 `lib/client.js` + `package.json` 的 `dsh.client`；本包没做 |
| 数据布局 | `lib/store.js` |
| 让某个目录不吃记忆 | 放 `.dsh-memory-off`；判断在 `lib/store.js` 的 `memoryDisabled`，摘挂在 `lib/index.js` 的 `tick` |

关键决策（别轻易改）：

1. **注入必须用 `context`**。`section` 每轮变会让系统提示缓存整段失效；`context` 只在内容变了才追加。
2. **`interpolate: false`**。否则记忆里一句 `{{time}}` 就让整间会话每轮报错。
3. **scope 用 cwd 的哈希**，不用会话 id：会话关了记忆还在，换会话还能接上；项目之间不会串。
4. **单写者**：不要为「共享库」再开第二个进程写。
5. **不自动删**：淡忘只降低命中率，`dedupe` 只合并不丢信息。

---

## 6. 已知坑 / 风险

| 坑 | 说明 |
| --- | --- |
| 插件 API 半公开 | 事件名、disposer 形状、`defineTool` 参数都是实测出来的；升级 DSH 后先跑一遍第 4 节 |
| profile 名是 `desktop` 不是 `web` | 需求文档里写的是 `--profile web`，实际装的是 `desktop`。装错 profile 等于没装 |
| 装完可能热加载 | 本机实测：不重启就在下一轮生效了。所以「装完必须重启」不总是成立，先看 diag |
| `diag.log` 是 UTF-8 无 BOM | PowerShell 5.1 的 `Get-Content` 默认按 GBK 读会乱码，要看请加 `-Encoding UTF8` |
| 工具表看不见 | 插件级注册 + 按会话注册各一份（fishmem 踩过：只插件级时新会话工具表里没有） |
| `ctx.interval` 返回值 | 防御式处理：返回函数才当 disposer；否则走 `ctx.effect` |
| 提炼抢资源 | 已加最小间隔（10 分钟）+ 每会话互斥；如果仍嫌贵，把 `extractEveryTurns` 调大或设 0 |
| 中文分词精度 | 字 + 二字，没有词表；「车站」和「车」会各自成词，靠 IDF 和门槛压噪音 |
| global 层每个实例一份（已修） | `lib/memory.js` 的 `sharedGlobalLayer` 让进程内只有一份。修之前「A 会话记的全局事实 B 会话看不见，还可能被 B 写回时覆盖」。只覆盖同进程，多进程仍各持一份 |

---

## 7. 下一步（按优先级）

1. **人工补一次 4/5**：关掉会话重开（同 cwd）、换 cwd 开新会话（看 global 还在、项目记忆不串）。
   剩下的 6（缓存命中）需要一个能看请求日志的环境。
2. 走完第 4 节；把 `diag.log` 里挂载/提炼两行贴出来。
3. 用一周真实会话，看「最近一次召回」——目前 `recalls` 只落盘，没有界面。可以先写个只读脚本：

   ```powershell
   Get-Content "$env:USERPROFILE\.dsh\deep-memory\ws-*.json" | ConvertFrom-Json | ForEach-Object { $_.recalls[-1] }
   ```

4. 觉得召回不够准，再考虑：给 `related` 检索词（fishmem 的做法）、或本地 embedding（不急着上）。
5. 最后才做设置页（client 半端）：本包刻意没做，避免第一版就卡在 UI 调试上。


## 7. 上传前复查（2026-10-31）

- 修复提炼 JSON 解析失败时把私人模型输出写进诊断日志的问题。
- 画像字段在写入前同样脱敏；新增隔离标记后，已有会话的工具和注入立即停止，进行中的提炼返回后不再写入。
- npm 发布文件使用明确白名单，避免 `viz-kit/data.json` 和 `data.sample.json` 进入安装包。
- 可视化服务器改用 `fileURLToPath`，支持中文及空格路径。
- 45 项测试全部通过；真实宿主的缓存命中仍未验证，多进程写入仍不支持。
- LICENSE 保留 contributors 署名；Git 提交使用 GitHub noreply 邮箱。
