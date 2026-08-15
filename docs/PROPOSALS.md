# 改进提案记录（2026-08-13 调研）

本文档记录对 dsh-grok-tui 的一次完整调研产出的所有改进方向（新功能 / 优化 /
工程维护），供后续排期与实现对照。状态字段说明每个方向的当前进度。

- **状态**: 待定（未选中） / 已选中（用户拍板，将实现） / 已实现 / 已放弃
- **价值**: 高 / 中 / 低 —— 对使用体验或工程质量的影响
- **成本**: 低 / 中 / 高 —— 实现工作量与风险

调研基线：`main@6a70ddd`（v0.3.8），122 个测试全部通过；DSH 快照
`~/.dsh/source/current`；grok-build 快照 `../grok-build`。

---

## 新功能（F）

### F1 · 命令桥接：/goal、/compact 等 DSH 命令进 TUI ✅ 已实现

- **状态**: 已实现（2026-08-13，分支 `feat/slash-commands`）
- **价值**: 高　**成本**: 中
- **现状**: `x.ai/commands/list` 返回空目录（ARCHITECTURE.md Known Limitations
  第 4 条），pager 只有内置命令（/resume /model /exit /plan /tasks 等），DSH
  注册的命令（/goal、/compact、/feedback 等）在 TUI 里完全不可用。
- **方案**:
  1. `x.ai/commands/list`：从 DSH 的 `ctx.commands.list(agent)` 读取命令目录，
     过滤掉与 pager 内置命令重名的条目后返回。
  2. 命令执行：pager 对 agent 命令没有执行扩展方法，选中后以
     `PassThrough` 文本（`/goal …`）作为普通 prompt 发出 —— 桥接在
     `session/prompt` 处拦截这类斜杠行，直接调用
     `ctx.commands.execute(agent, line, signal)`，结果以单条 assistant
     消息回显。
- **实现**:
  - `src/commands-bridge.ts`：内置命令冲突名单（从 grok-build
    slash/commands 提取）、斜杠行解析、目录过滤与 wire 映射
  - `src/acp-server.ts`：`x.ai/commands/list` 应答、session/new、load 与
    re-align 后推送 `available_commands_update`、`commands/change` 实时刷新、
    prompt 拦截执行、`session/cancel` 中止执行
  - `scripts/serve-real.ts`：standalone 挂载 `dsh-commands` +
    `dsh-command-goal`（host 模式由 web profile 自带；该文件在 v0.5.0
    bridge-only 变更中已删除）
  - 测试：`tests/commands-bridge.spec.ts` 14 例；全套 136 例通过
- **依据**: DSH `packages/interaction/commands/src/index.ts`（`CommandRuntime`
  的 `list` / `execute` 远程方法）；grok-shell
  `extensions/session_admin.rs` 的 `handle_commands_list`（请求带
  kind/sessionId/cwd 参数）。

### F2 · 会话标题上线（session_info_update）✅ 已实现

- **状态**: 已实现（2026-08-14，分支 `feat/session-title`）
- **价值**: 高　**成本**: 低
- **现状**: 会话标题不上线（Known Limitations 第 5 条），pager 的标题回退为
  第一条 prompt 文本。
- **方案**: 监听 DSH 的 `session/title` 事件，通过 `session_info_update` 通知
  把标题推给 pager。仓库已有 `sessionTitleFromLog` 读取器（
  `src/first-prompt.ts`），grok-shell 端 `notify_session_info_update` 已确认
  存在。
- **实现**:
  - `src/translate/events.ts`：`translateEvent` 对 `session/title` 事件返回
    标准 ACP `session_info_update` 通知（`session/title` 是 dsh-session-title
    插件合并的事件类型，`SessionEvent` 联合不携带，结构性收窄处理）
  - `src/acp-server.ts`：`session/event` 监听器对 `session/title` 事件额外
    发送 `x.ai/session_notification` ExtNotification（`SessionSummaryGenerated`
    变体）——pager 的 update matcher 忽略标准 `session_info_update`，只消费
    该扩展通知（设置 `generated_session_title`）；与 grok-shell
    `notify_client` 的双通道行为一致
  - 测试：`tests/translate.spec.ts` 2 例（翻译 + 空标题跳过）、
    `tests/acp.spec.ts` 1 例（双通道端到端）；全套 139 例通过
- **依据**: grok-shell `agent/mvp_agent/agent_ops.rs`（`notify_session_info_update`）
  与 `session/summary.rs`（`notify_client` 双通道）；pager
  `app/acp_handler/session_notification.rs`（`SessionSummaryGenerated` →
  `generated_session_title`）。

### F3 · 用量面板增强：TTFT / TPS / 会话切换 ✅ 已实现

- **状态**: 已实现（2026-08-14，分支 `feat/usage-panel-pagination`）
- **价值**: 中　**成本**: 低
- **现状**: tmux 用量面板（`scripts/usage-panel.mjs`）只显示
  cache/input/output/total/api/tool 六项；usage view（`src/usage.ts`
  `DshUsageView`）其实已含 `ttftMs`、`tps` 字段（herdr 侧栏在用）。
- **方案**: 面板补上 TTFT 与 TPS 两行；跟随当前活跃会话（status 文件已有
  sessionId 字段）。
- **实现**:
  - `scripts/usage-panel.mjs`：新增 `ttft`（平均首 token 时延，ms/s 格式）
    与 `tps`（平均输出 token/秒）两行；status 文件始终持有最近活跃会话
    （bridge 每次通知覆写并盖 sessionId），面板跟随其变化，会话切换时
    footer 显示 `(switched)` 标记；`renderView`/`fmtDuration`/`fmtTps`
    导出为纯函数（main guard 保证导入不启动轮询），面板盒子加宽对齐
  - 测试：`tests/usage-panel.spec.ts` 6 例（TTFT/TPS 行、缺失值兜底
    `–`、切换标记、无 usage 容错）；全套 151 例通过
- **依据**: `src/usage.ts` `DshUsageView`（`ttftMs`/`tps` 字段）；
  `scripts/herdr-usage-watcher.mjs` 的格式化惯例。

### F4 · 图片粘贴桥接（远期）

- **状态**: 待定　**价值**: 中　**成本**: 高
- **现状**: `initialize` 声明 `promptCapabilities.image: false`，图片输入被
  拒绝；pager 端本身支持剪贴板图片（`prompt_images::from_clipboard_data`）。
- **方案**: 图片落盘后引导模型用 view_image 工具读取（DeepSeek 模型无原生
  视觉，这是主要约束）；需要扩展 initialize 的 promptCapabilities 与
  session/prompt 的 image 块解析。
- **依据**: pager `app/effects/mod.rs` 剪贴板附件探测。

### F5 · resume 列表分页与搜索 ✅ 已实现

- **状态**: 已实现（2026-08-14，分支 `feat/usage-panel-pagination`）
- **价值**: 中　**成本**: 中
- **现状**: `x.ai/session/list` 一次返回最多 100 个会话、无分页 cursor
  （`nextCursor: null`）；大 store（数百会话）时 picker 拥挤。
- **方案**: 研究 pager 的分页协议，实现 cursor 分页。
- **调研结论**: pager 的 resume picker 只在打开时拉一次
  `x.ai/session/list`（`limit: 30`），从不发送 cursor、也不消费
  `nextCursor`（无滚动加载）；但 grok-shell 的 unified_list 协议本身支持
  cursor 分页（`CompositeCursor`：base64url 编码的
  `{ boundary: { updated_at, kind, session_id } }`，请求带 `cursor`、
  响应带 `nextCursor`）。pager 搜索框发 `query` 参数，DSH 侧此前完全忽略。
- **实现**:
  - `src/acp-server.ts` `x.ai/session/list`：全路径尊重 `limit`（默认 30，
    上限 100，不再强制 100 行窗口——picker 显示一页 30 行，不再拥挤）；
    支持 `cursor` 参数（容错解码，畸形 cursor 回退首页）与 `nextCursor`
    响应（边界 = 已检查窗口最后一行，死行页也能前进）；支持 `query`
    搜索（title/firstPrompt/sessionId 大小写不敏感子串，与 grok-shell
    merge.rs 语义一致）；排序改为全序（lastActive 降序 + sessionId 升序，
    与 cursor 边界同键）；firstPrompt 读取加 8 并发池（顺带缓解 I5）
  - 测试：`tests/m4.spec.ts` 6 例（cursor 全量遍历无重复、browse 分页、
    畸形 cursor 回退、prompt 文本搜索、sessionId 搜索、搜索分页遍历）；
    全套 151 例通过
- **依据**: grok-shell `session/unified_list/mod.rs`（`ListReq.cursor`、
  `merge_and_paginate`、`ext_list_response`）与 `cursor.rs`
  （`CompositeCursor` 编解码）；`session/merge.rs`（query 匹配语义）；
  pager `app/effects/mod.rs` `Effect::FetchSessionList`（limit 30、query
  参数、无 cursor）。

### F6 · MCP 服务器桥接（远期）

- **状态**: 待定　**价值**: 中　**成本**: 高
- **现状**: pager config.toml 的 MCP servers 在 session/new 时被忽略（设计
  如此，避免带 secrets 的配置泄漏给 DSH）。
- **方案**: 读取 pager 的 MCP 配置并经 DSH 的 mcp 服务注册为 DSH 侧客户端；
  安全边界（secrets、命令来源）需要仔细设计。

---

## 优化（I）

### I1 · CI 流水线（GitHub Actions）✅ 已实现

- **状态**: 已实现（2026-08-14，分支 `feat/usage-panel-pagination`，并
  cherry-pick 到 `main` / `feat/slash-commands` / `feat/bridge-only` /
  `feat/session-title`，每个分支 push 都会触发）
- **价值**: 高　**成本**: 低
- **现状**: 仓库无任何 CI，122 个测试全靠本地跑。
- **方案**: `.github/workflows/ci.yml`：pnpm install + pnpm test + biome
  check + build（DSH_PATH 用固定 dsh 快照 checkout），push / PR 自动执行。
- **实现**:
  - `.github/workflows/ci.yml`：`on: push` + `on: pull_request`（一份配置
    覆盖所有分支；push 事件检查被推送分支上的工作流文件，因此每个分支
    都带同一份 ci.yml）；步骤 = pnpm install → 用固定 deepseek-harness
    commit `47f94385`（2026-08-13，与本地快照 08-12 最接近的公开 commit）
    生成 tsconfig.json（`@deepseek-ai/*` 经 tsconfig paths 解析到 dsh
    源码，与本地 `~/.dsh/source/current` 机制一致）→ `pnpm add -D`
    `cordis@npm:@deepseek-ai/cordis@4.0.1-rc.1` 与
    `schemastery@npm:@deepseek-ai/schemastery@3.18.1-rc.1`（裸名 import
    不在 paths 覆盖内，装 vendored 版本）→ `pnpm test` → `biome lint`
    → `DSH_PATH=... pnpm build`
  - 偏离方案的两点：① biome 用 `biome lint` 而非 `biome check`（check
    含 format 检查，仓库存在大量既有格式差异，lint 严格检查代码质量）；
    ② 修复了 19 处既有 lint 错误（useTemplate / useLiteralKeys /
    noUnusedVariables / noImplicitAnyLet / noNonNullAssertion /
    noUnsafeOptionalChaining 等，测试断言处加 biome-ignore 注释），
    biome.json 排除 dist（生成物）并改用 `preset` 字段
  - 排障记录（CI 首跑全红后逐项修复）：
    ① `ERR_PNPM_OUTDATED_LOCKFILE`：仓库 lockfile 与 package.json 不一致
    （缺 schemastery resolution、peer 未记录），CI 的 frozen-lockfile
    直接拒绝；用 `--config.auto-install-peers=false` 重新生成 lockfile
    并提交（peer 不记录，本地手工 symlink 不受影响），CI 的 install
    显式传同参数匹配 lockfile settings；
    ② `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`：lockfile settings 与 install
    参数不一致，workflow 显式传 `--config.auto-install-peers=false`；
    ③ jsdom 环境缺失：dsh 快照 checkout 在工作目录内，rstest 的 include
    模式 `**/*.{test,spec}.ts` 扫到 dsh 的 692 个 spec 文件（部分带
    `@vitest-environment jsdom` 注释）→ 改用 git clone 到
    `$RUNNER_TEMP/dsh`（工作区外，actions/checkout 拒绝工作区外路径）；
    ④ m4.spec.ts 的 300ms 固定等待 flaky（JSONL 异步落盘，慢 runner 上
    session/list 偶发读不到）→ 改为 pollForSession 轮询（25ms×200）
  - 验证：本地完整模拟 CI 环境（干净 clone + registry 依赖 + 固定 dsh
    commit）151 例测试全绿、lint 全绿、build 通过；各分支基线测试
    main 122 / slash-commands 136 / bridge-only 136 / session-title 139
    全部通过；GitHub Actions 实测 6 个分支全部 success
- **依据**: 本地开发环境依赖解析机制（tsconfig paths + node_modules
  链接）；deepseek-harness 公开仓库（`@deepseek-ai/dsh-root`）与 npm
  registry 上的 vendored 包（`@deepseek-ai/cordis` 等）。

### I2 · usage 状态文件写盘节流

- **状态**: 待定　**价值**: 中　**成本**: 低
- **现状**: `src/acp-server.ts` 的 `notify()` 对每个带 usage 的通知都
  writeFile 一次 `~/.dsh/grok-usage.json`；token 高频流时无效磁盘 IO。
- **方案**: 200–500ms 合并写（防抖 + 尾写）。

### I3 · host 桥探测合并为单进程

- **状态**: 待定　**价值**: 低　**成本**: 低
- **现状**: `grok-dsh.sh` 对每个候选 socket fork 一个 node 进程
  （`probe-host-bridge.mjs`，最多 10 次握手重试），启动开销大。
- **方案**: 单进程探测全部候选 socket，一次握手输出结果。

### I4 · 会话健康检查增量扫描

- **状态**: 待定　**价值**: 中　**成本**: 中
- **现状**: standalone 模式每 15s 全量 glob + stat 整个 session store；
  文档记录了 355MB store 单轮 ~118s、并发 pass 叠到 ~487% CPU 的教训
  （host 模式因此禁用 watch；v0.5.0 起 standalone 已移除，watch 默认关闭，
  需要时显式 healthWatch: true）。
- **方案**: 只扫描 mtime 变化的目录，或限制单轮处理数量。

### I5 · session/list 扫描并发限制

- **状态**: 待定　**价值**: 低　**成本**: 低
- **现状**: `x.ai/session/list` 对每个会话并行 stat + 头部帧读取（
  `Promise.all`），大目录瞬时打开大量文件描述符。
- **方案**: 加并发池（如 8）限制。

### I6 · 版本号同步（SERVER_VERSION）

- **状态**: 待定　**价值**: 低　**成本**: 低
- **现状**: leader 通告的 `dsh-grok-tui-0.1.0`（`src/index.ts`）与
  package.json 的 0.3.8 长期不一致，排查时易混淆。
- **方案**: 构建时从 package.json 注入版本号。

---

## 工程维护（M）

### M1 · README 故障排查章节

- **状态**: 待定　**价值**: 中　**成本**: 低
- **现状**: README 使用章节无 troubleshooting。
- **方案**: 补充常见问题：socket 冲突、双前端同时写会话、模型未找到、官方
  二进制无状态栏等诊断路径。

### M2 · 端到端 PTY 测试接入

- **状态**: 待定　**价值**: 中　**成本**: 中
- **现状**: `research/m0-server/drive_pty.py` 已能无头驱动真实 pager，但未
  纳入测试套件。
- **方案**: 做成可选的 e2e 测试（依赖 grok-build 二进制），验证真实握手与
  流式渲染。

---

## 已实施的方向变更

### B2 · 分支安装流程（GitHub 分支直装，零发布）✅ 已实现（v0.5.0）

- **状态**: 已实现（2026-08-14，分支 `feat/bridge-only`）
- **背景**: 用户需要在另一台设备上安装并测试各分支的新功能。最初设计
  为"每分支发布独立公共 npm 包"（publish-branch.sh），向用户讲解 npm
  发布机制后，用户选择更合适的 **GitHub 分支直装**：零发布、零包名
  占用、始终最新代码。
- **方案**:
  - 目标设备一条命令：`npm install -g github:chen-001/dsh-grok-tui#<分支>`
  - 装的是分支最新提交（含已提交的 dist）；每次 push 后重跑即更新
  - 项目原生支持：dist 一直提交（.gitignore 注释写明 git 安装需要）、
    postinstall 的 materialize 逻辑处理 npm git-clone 缓存
  - `docs/BRANCH-INSTALL.md`：完整流程（安装/换分支/发布侧流程/注意
    事项）
  - README 增加「分支安装」章节
  - `scripts/publish-branch.sh` 保留为可选工具（未来公开分发时用）
- **验证**: 分支推送后实测 npm 安装命令（见 v0.5.0 提交记录）

---

### B1 · 移除 standalone 模式，只保留桥接模式 ✅ 已实现（v0.5.0）

- **状态**: 已实现（2026-08-13，分支 `feat/bridge-only`）
- **背景**: 用户要求 grok-dsh 以后只有桥接模式——必须先启动 `dsh web`，
  才能使用 grok-dsh。
- **改动**:
  - `scripts/grok-dsh.sh`：删除 standalone 全部逻辑（start_server /
    stop_server / server_pid / check_dsh / stop / restart 命令），host
    探测失败时报错退出并提示先启动 `dsh web`；保留 status / setup 命令
  - `scripts/serve-real.ts`：删除（standalone 后端入口）
  - `src/index.ts`：`userInteractionProvider` 与 `healthWatch` 默认值
    改为 false（host 模式语义；需要时显式 opt-in）
  - `scripts/serve.ts`、`tests/helpers.ts`、`tests/m3.spec.ts`：显式
    opt-in 保持原行为
  - 文档：README / ARCHITECTURE / COMPATIBILITY / install.sh /
    grok-server.yml / probe-host-bridge.mjs / install-profile.mjs 全面
    清理 standalone 描述
- **验证**: 全套 136 例测试通过；build 通过

---

## 实现纪律（F1 起生效）

- 新功能在 **chen-001/dsh-grok-tui** 上从 `main` 派生新分支，不直接改 main。
- 每个逻辑改动验证通过后本地 git commit（回滚点），不主动 push。
- 实现对照本文档的「方案」与「依据」，偏离时更新本文档。
