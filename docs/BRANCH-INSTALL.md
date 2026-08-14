# 分支安装流程（Branch Install Workflow）

在**另一台设备**上安装并测试某个分支的构建，**不需要发布到公共 npm**：
直接把分支推到 GitHub（chen-001/dsh-grok-tui），目标设备用一条 npm 命令
从 GitHub 分支安装。零发布、零包名占用、始终是最新代码。

## 目标设备安装（一条命令）

```bash
npm install -g --legacy-peer-deps github:chen-001/dsh-grok-tui#feat/bridge-only
```

- `--legacy-peer-deps` 是必需的：peerDependencies 里的 `@deepseek-ai/*`
  是未发布的 workspace 包（运行时由 dsh checkout 提供），npm 7+ 严格
  解析会报 ERESOLVE；该 flag 跳过自动安装 peer 依赖（项目自己的
  .npmrc 就是这么配的，但目标设备不会读仓库里的 .npmrc）
- `#` 后面是分支名：`feat/slash-commands`、`feat/bridge-only`、未来的
  `feat/xxx` 都这样装
- 装的是该分支**当前最新提交**（含已提交的 `dist` 构建产物），每次
  push 后重新执行该命令即更新到最新
- 安装时自动运行 postinstall（materialize npm 的 git-clone 缓存符号链接 +
  herdr 侧栏配置，均幂等）

装好后接 dsh web 桥（每台设备一次）：

```bash
grok-dsh setup      # 把 grok bridge 挂进 dsh web profile（幂等）
dsh web             # 先启动官方 host
grok-dsh            # 打开 TUI（bridge-only：必须 host 先运行）
```

## 换测另一个分支

```bash
npm uninstall -g dsh-grok-tui        # 先卸载旧包（bin 同名 grok-dsh 会冲突）
npm install -g --legacy-peer-deps github:chen-001/dsh-grok-tui#feat/slash-commands
```

## 发布侧流程（本机，每次分支有更新时）

```bash
# 1. 在该分支上开发、测试（pnpm test 全绿、build 通过）
git checkout feat/xxx
pnpm test

# 2. 提交（dist 必须一起提交：git 安装用的是仓库里的 dist）
git add -A && git commit -m "..."

# 3. 推送分支到 GitHub（目标设备即可安装）
git push origin feat/xxx
```

## 为什么不用"每分支发布独立 npm 包"

最初设计过 `scripts/publish-branch.sh`（把每个分支发布为
`dsh-grok-tui-<slug>` 独立公共 npm 包）。结论是**不需要**：

- 公共 npm 发布是"公开发行"，包名全局唯一且永久占用，会在账号下积累
  试验品/僵尸包，删除还要走人工流程；
- 自测场景只是"两台设备之间传代码"，GitHub 分支安装零成本、零占用、
  始终最新（npm 发布是冻结快照，每次更新要重新发布）；
- 项目从设计上就支持 git 安装：`dist/` 一直提交在仓库里（.gitignore
  注释写明"git-based installs need the built entry"），postinstall 的
  materialize 逻辑专门处理 npm 的 git-clone 缓存。

`scripts/publish-branch.sh` 保留为**可选工具**：如果哪天真要公开分发
（例如给别人用），再按它的流程发布独立包。

## 注意事项

- **分支必须已推送**：`npm install github:...#branch` 装的是 GitHub 上的
  分支，本地未推送的分支装不到。
- **GitHub 仓库保持 public**：git 安装依赖公开仓库；若未来转私有，
  需要配置 token 才能装。
- **bin 冲突**：所有分支的可执行命令都叫 `grok-dsh`，同一台设备同时
  只装一个分支；切换时先卸载旧的。
- **网络**：npm 从 GitHub 安装需要能访问 github.com（本机 git/npm
  网络操作按惯例走代理）。
