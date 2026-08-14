# 分支 NPM 发布流程（Branch NPM Publishing）

每个功能分支发布为一个**独立的 npm 包**，另一台设备用一条 `npm install`
命令即可安装并测试该分支的构建。这是 dsh-grok-tui 的固定开发范式。

## 包名规则

| Git 分支 | npm 包名 | 说明 |
|---|---|---|
| `main` | `dsh-grok-tui` | 官方包（发布流程见下） |
| `feat/slash-commands` | `dsh-grok-tui-slash-commands` | 分支名最后一段做 slug |
| `feat/bridge-only` | `dsh-grok-tui-bridge-only` | 同上 |
| 未来 `feat/xxx` | `dsh-grok-tui-xxx` | 同上（slug 必须全小写字母数字+连字符） |

版本号自动带上 commit：`0.5.0-bridge-only.414a73e` —— 每次发布唯一、可追溯到
具体提交，无需手动管理版本递增。

## 发布流程（每分支）

```bash
# 1. 在该分支上开发、测试（pnpm test 全绿、build 通过）
git checkout feat/xxx
pnpm test

# 2. 提交（发布要求工作区干净）
git commit -m "..."

# 3. 发布独立包（需要 npm 已登录，一次性执行 npm adduser）
scripts/publish-branch.sh feat/xxx

# 4. （可选）先 dry-run 验证
scripts/publish-branch.sh feat/xxx --dry-run
```

脚本做什么：

1. 校验：工作区干净、当前分支 = 目标分支、slug 合法
2. 用 `DSH_PATH`（默认 `~/.dsh/source/current`）构建 dist
3. 检查 `npm whoami`（未登录则提示先 `npm adduser`）
4. 检查包名占用（已存在但 maintainer 不是自己 → 拒绝）
5. 用 `git archive` 打包到临时目录 + 覆盖新构建的 `dist/index.js` +
   改写 `package.json` 的 name/version（**不动工作区**）
6. `npm publish --access public`
7. 输出目标设备安装命令

## 目标设备安装 / 更新 / 卸载

```bash
# 安装（一条命令）
npm install -g dsh-grok-tui-slash-commands

# 接好 dsh web 桥（每台设备一次）
grok-dsh setup
dsh web            # 先启动官方 host
grok-dsh           # 打开 TUI（bridge-only：必须 host 先运行）

# 分支有新提交后更新到最新构建
npm install -g dsh-grok-tui-slash-commands@latest

# 换测另一个分支前，先卸载旧包（bin 同名 grok-dsh 会冲突）
npm uninstall -g dsh-grok-tui-slash-commands
npm install -g dsh-grok-tui-bridge-only
```

## main 的发布（合并回主干后）

`dsh-grok-tui`（无 slug）走常规流程：bump 版本 → 构建 → `npm publish`。

```bash
git checkout main && git pull
# package.json 版本已 bump
npm run build
npm publish --access public
```

## 注意事项

- **npm 登录**：发布需要账号（本机一次性 `npm adduser`）；新包名首次发布
  任何登录账号都可以，之后只有 maintainer 能更新。
- **bin 冲突**：所有分支包的可执行命令都叫 `grok-dsh`，同一台设备同时
  只装一个分支包；切换分支包时先卸载旧的。
- **发布的是构建快照**：包内容 = 发布时该分支 HEAD 的源码 + dist，
  与分支后续提交无关，需要更新就重新发布（版本自动带新 commit）。
- **GitHub 仓库保持 public**：`git archive` 与安装脚本都依赖它；若未来
  仓库转私有，npm 发布不受影响（registry 与 git 无关），但
  `install.sh` 的 raw URL 与 git 安装会失效。
