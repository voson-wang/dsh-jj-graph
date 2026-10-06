# dsh-jj-graph

> DSH 插件：DeepSeek Harness Web GUI 里的**只读** Jujutsu（jj）变更图谱。
> A read-only Jujutsu change graph for the DeepSeek Harness Web UI.

参考 [`dsh-git-graph`](https://github.com/1841220388zzzcccxxx-star/dsh-git-graph) 的插件形态与图形页面实现，把数据层从 `git` 换成 `jj`。
会话视图里多出一个「JJ 图谱」标签页：变更图谱、书签过滤、逐变更 diff、工作副本面板。

![JJ 图谱在浅色主题下](docs/screenshot-light.png)

## 功能

| 区域 | 说明 |
|---|---|
| 仓库发现 | 自动采用当前会话工作区（向上找 `.jj`）；顶栏「📂 打开」可浏览磁盘添加任意 jj 仓库；内存态允许列表在 dsh 重启后由页面重新注册 |
| 变更图谱 | `jj log -r 'all()'`，自绘泳道图；`@`（工作副本）用绿色环标记；分页每次 200 条 |
| 书签过滤 | 本地书签 / 远程书签分别成组，可折叠、可勾选过滤；`main@origin` 之类远程书签单独着色 |
| 变更详情 | 点击任一变更 → 元信息（**变更 ID** / 提交 ID / 作者 / 时间 / 父变更）、完整描述、`--stat`、完整 patch |
| 单文件 diff | 详情面板里点文件 → 该变更中此文件的 diff；右键文件可看该文件的变更历史 |
| 工作副本面板 | `@` 的全部改动（jj 没有暂存区，所以是**一个**分组），逐文件 +/− 计数，点击展开该文件的 diff |
| 搜索 | 描述 / 作者 / 邮箱 / change id / commit id |
| 主题 | 「自动」跟随 Harness 界面浅色/深色（读取 `body[data-ds-dark-theme]`，属性存在=深色），并随壳层实时切换；另有 8 套配色预设 |

## 只读保证

这个插件**不提供任何写操作**：没有 `jj describe` / `jj commit` / `jj abandon` / `jj git push` 的按钮，Host 半也**不注册任何会改仓库的 op**（`gitop` 之类一律 404）。

纯读 op（`graph` / `branches` / `show` / `diff` / `filediff` / `filelog` / `remoteinfo`）都带 `--ignore-working-copy`，所以**打开页面不会快照工作副本、不会往 `jj op log` 里追加操作**。

只有 `workstatus` / `workfile`（必须反映工作副本当前状态）允许 jj 正常快照——和你在终端敲 `jj status` 的行为一致。

这条保证有测试兜底：`test/ops.test.mjs` 会在每个纯读 op 前后比对 `jj op log` 的条目数，多一条就 FAIL。

## 环境要求

- `jj` ≥ 0.45（开发与测试基于 0.45.1）；`jj` 必须在 DSH 宿主进程的 `PATH` 上
- DSH（DeepSeek Harness）桌面版；插件按 bundle 形态安装进 profile

## 安装

插件是标准的 DSH bundle（`package.json` 声明 `dsh.bundle.patch`、`dsh.client`）。两种装法：

1. **创造模式的 Plugin Manager**（推荐）：
   ```js
   plugin_manager({ action: "install_bundle", target: "/绝对路径/refining/dsh-jj-graph" })
   ```
2. **Web 侧边栏「插件」页**：安装 bundle，目标填本仓库的绝对路径；安装后在会话视图里切到「JJ 图谱」。

装完不需要重启（在线 profile 会重新组合、Client bundle 走 HMR）；若页面没出现，重载一次窗口。

## 本地验证

```sh
# Host 半：39 项断言，含只读保证（自建 scratch 仓库，不碰你的仓库）
node test/ops.test.mjs

# 页面：DOM 复刻壳层 + 真实 handler，断言主题跟随 / 输入框隐藏 / 审批面板保留
node tools/verify-ui/serve.mjs --repo <一个 jj 仓库> --port 8981   # 然后开 http://127.0.0.1:8981/
node tools/verify-ui/check.mjs --repo <一个 jj 仓库>               # 自动跑完全部场景
```

## 设计要点

- **数据抽取**：所有字段都经 jj 模板的 `json()` 输出、用真实 Tab 分隔，再逐段 `JSON.parse`。
  jj 模板语言没有 `\x1f` 转义、也没有列表字面量（`[a, b]` 会语法错误），`json()` 会把值里的
  Tab/换行/引号转义掉，因此描述里出现任何字符都不会错列。
- **没有暂存区**：jj 的工作副本本身就是一个 commit（`@`），所以面板只有一个分组；页面里
  git 时代的暂存/批量操作代码整块删除，而不是留着等运行时报错。
- **书签 ≠ 分支**：`jj bookmark list --all-remotes` 还会列出 git 后端的合成远程 `git`，
  真远程另有其人——插件用 `jj git remote list` 的结果过滤，只保留真实远程。
- **根提交**：jj 的 `root()`（全 0 commit id）不出现在图里，`total` 用 `(revset) ~ root()` 计数，
  所以分页总数和实际行数一致。
- **绝对路径**：所有 jj 调用都 `cwd = 仓库根`，因为 jj 的 pathspec / `files()` 是相对**进程工作目录**
  而不是仓库根解析的。

## 已知限制（v0.1）

- 只读：改历史、建书签、推送都要回终端用 `jj`。
- 单仓库视图：一次只显示一个仓库（顶栏可切换）。
- 大仓库：`all()` 全量取；页面按 200 条分页，但 `total` 需要一次完整 revset 遍历（有 5 秒缓存）。
- 不显示 jj 的 `divergent` / `hidden` 特殊状态，也不画 jj 自带的图（自绘泳道）。

## 回滚

在侧边栏「插件」页停用或删除该 bundle；或从 profile 的 `package.json` / `cordis.patch.yml` 里移除相关行。
仓库本身无副作用：插件只在内存里维护「最近使用过的仓库」列表。

## License

MIT
