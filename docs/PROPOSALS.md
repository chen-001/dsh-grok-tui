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
    `dsh-command-goal`（host 模式由 web profile 自带）
  - 测试：`tests/commands-bridge.spec.ts` 14 例；全套 136 例通过
- **依据**: DSH `packages/interaction/commands/src/index.ts`（`CommandRuntime`
  的 `list` / `execute` 远程方法）；grok-shell
  `extensions/session_admin.rs` 的 `handle_commands_list`（请求带
  kind/sessionId/cwd 参数）。

### F2 · 会话标题上线（session_info_update）

- **状态**: 待定　**价值**: 高　**成本**: 低
- **现状**: 会话标题不上线（Known Limitations 第 5 条），pager 的标题回退为
  第一条 prompt 文本。
- **方案**: 监听 DSH 的 `session/title` 事件，通过 `session_info_update` 通知
  把标题推给 pager。仓库已有 `sessionTitleFromLog` 读取器（
  `src/first-prompt.ts`），grok-shell 端 `notify_session_info_update` 已确认
  存在。
- **依据**: grok-shell `agent/mvp_agent/agent_ops.rs`。

### F3 · 用量面板增强：TTFT / TPS / 会话切换

- **状态**: 待定　**价值**: 中　**成本**: 低
- **现状**: tmux 用量面板（`scripts/usage-panel.mjs`）只显示
  cache/input/output/total/api/tool 六项；usage view（`src/usage.ts`
  `DshUsageView`）其实已含 `ttftMs`、`tps` 字段（herdr 侧栏在用）。
- **方案**: 面板补上 TTFT 与 TPS 两行；跟随当前活跃会话（status 文件已有
  sessionId 字段）。

### F4 · 图片粘贴桥接（远期）

- **状态**: 待定　**价值**: 中　**成本**: 高
- **现状**: `initialize` 声明 `promptCapabilities.image: false`，图片输入被
  拒绝；pager 端本身支持剪贴板图片（`prompt_images::from_clipboard_data`）。
- **方案**: 图片落盘后引导模型用 view_image 工具读取（DeepSeek 模型无原生
  视觉，这是主要约束）；需要扩展 initialize 的 promptCapabilities 与
  session/prompt 的 image 块解析。
- **依据**: pager `app/effects/mod.rs` 剪贴板附件探测。

### F5 · resume 列表分页与搜索

- **状态**: 待定　**价值**: 中　**成本**: 中
- **现状**: `x.ai/session/list` 一次返回最多 100 个会话、无分页 cursor
  （`nextCursor: null`）；大 store（数百会话）时 picker 拥挤。
- **方案**: 研究 pager 的分页协议，实现 cursor 分页。

### F6 · MCP 服务器桥接（远期）

- **状态**: 待定　**价值**: 中　**成本**: 高
- **现状**: pager config.toml 的 MCP servers 在 session/new 时被忽略（设计
  如此，避免带 secrets 的配置泄漏给 DSH）。
- **方案**: 读取 pager 的 MCP 配置并经 DSH 的 mcp 服务注册为 DSH 侧客户端；
  安全边界（secrets、命令来源）需要仔细设计。

---

## 优化（I）

### I1 · CI 流水线（GitHub Actions）

- **状态**: 已实现（2026-08-14，分支 `feat/usage-panel-pagination`，CI 覆盖全分支）
- **现状**: 仓库无任何 CI，122 个测试全靠本地跑。
- **方案**: `.github/workflows/ci.yml`：pnpm install + pnpm test + biome
  check + build（DSH_PATH 用固定 dsh 快照 checkout），push / PR 自动执行。

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
  （host 模式因此禁用 watch，standalone 仍全量扫）。
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

## 实现纪律（F1 起生效）

- 新功能在 **chen-001/dsh-grok-tui** 上从 `main` 派生新分支，不直接改 main。
- 每个逻辑改动验证通过后本地 git commit（回滚点），不主动 push。
- 实现对照本文档的「方案」与「依据」，偏离时更新本文档。
