---
name: release-kit
description: 在接入了 ouraihub/release-kit 的仓库里写提交信息、发版、给新项目接入发布流程，或排查发布 PR、tag、CHANGELOG 问题时使用。仓库根目录有 release-kit.json 或 release-please-config.json 就说明已接入。
---

# release-kit

流程：日常提交 → 机器人维护"发布 PR"（版本号和中文 CHANGELOG）→ 合并发布 PR 就是发版 → 合并提交构建一次，全部成功后自动打 tag → 发布工作流复用这次构建的产物。

## 写提交（最常用）

```
<type>(<scope>): <摘要>

[可选正文：只写 diff 看不出来的原因，最多 6 行]
```

- type 只能用：`feat` `fix` `perf` `revert`（会进 CHANGELOG），`refactor` `docs` `test` `build` `ci` `chore` `style`（不进）。
- 标题不超过 72 个字符，结尾不加句号，摘要用仓库约定的语言。
- `feat`/`fix`/`perf` 的标题会原样写进更新日志，所以写用户能感知的效果，不写实现细节。
- 一条提交只做一件事。标题里需要用"和"、逗号或斜杠连接几件事时，拆成几条提交。
- 不写文件列表、字段清单、验证记录（`Verified:`、`验证：`、`测试通过`），也不写 AI 署名（`Co-authored-by: Claude`、`Generated with …`）。
- 提交信息、代码注释和标识符里都不能出现 `release-kit.json` 的 `forbidden` 中的词（参考或对标项目名）。来源写进设计文档。
- 破坏性变更写成 `feat!:`，或者加 `BREAKING CHANGE: <迁移方式>` 脚注。
- 推送前，把同一问题的多次修补合并成一条提交。

| 不要这样写 | 这样写 |
|---|---|
| `feat(ai): XX-style model settings with end-to-end effect` | `feat(ai): 设置中可编辑模型名称、分组和价格` |
| `fix: pin Aether 94dfe82 and disable sync actions until bound` | `fix(sync): 未绑定账号时禁用同步按钮`（升级依赖单独提交 `chore(deps): …`） |
| 正文 9 行逐条列出改了哪些字段 | 不写正文，或者用 1 行说明根因 |

推送前在本地检查：`npx github:ouraihub/release-kit check`（项目里装了的话也可以用 `pnpm exec release-kit check`）。它会检查上游分支之后的新提交，并扫描所有被跟踪的文件。

## 发版

- 不要手改版本号，不要手改 `.release-please-manifest.json` 或 `CHANGELOG.md`，也不要手动打 tag。
- 发版就是合并 `chore(main): release …` 这个发布 PR。合并后等构建全部通过，tag 和 Release 会自动生成。
- 想指定版本时，在一条提交里加脚注 `Release-As: 1.2.0`。
- 没有出现发布 PR，说明上次发版以来没有 `feat`/`fix`/`perf`/`revert` 提交，不需要发版。

## 接入新项目

1. 前提：上一次发布的 tag 已经存在（比如 `v1.4.0`、`desktop-v0.2.1`）。新项目还没发布过时，`--version` 写 `0.0.0`。
2. 运行 init。每个写了版本号的文件都要用一个 `--version-file` 列出：

   ```bash
   npx github:ouraihub/release-kit init --version 1.4.0 [--component desktop] \
     --version-file package.json --version-file src-tauri/Cargo.toml --version-file src-tauri/Cargo.lock \
     --forbid 参考项目名
   ```

   - JSON 文件改的是 `$.version`。`Cargo.toml` 会自动判断改 `workspace.package` 还是 `package`。`Cargo.lock` 只改本地包。
   - 版本号尽量只保留一个来源。Tauri 项目删掉 `tauri.conf.json` 里的 `version`，它会回退读 Cargo 的版本。
3. 在项目已有的构建工作流末尾加 `tag` job，写法见 README 的"构建成功后打 tag"。`needs` 要包含所有平台的构建 job。
4. 发布工作流监听 `push: tags`，只下载同一提交的构建产物，不重新编译。发布说明用 `npx --yes github:ouraihub/release-kit#v0 notes <版本>` 生成。
5. 仓库设置：
   - 开启 Actions 创建 PR：`gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`
   - 添加 secret `RELEASE_TOKEN`（PAT 或 App token），`tag` job 用它打 tag。
6. 把 `pnpm run ci` 或项目的检查命令的第一步设为 `release-kit check`，在 AGENTS.md 里写上"提交和注释规则见 release-kit"。

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志显示 `No user facing commits found` | 只有 chore/docs/ci 等提交 | 正常，不需要发版 |
| `GitHub Actions is not permitted to create or approve pull requests` | 仓库设置没开 | 运行上面第 5 步的 `gh api` 命令，再重跑工作流 |
| 推送被拒：`refusing to allow an OAuth App to create or update workflow` | 令牌缺少 `workflow` 权限 | `gh auth refresh -h github.com -s workflow` |
| tag 已经建了，但发布工作流没有触发 | `tag` job 用的是 `GITHUB_TOKEN` | 改用 `secrets.RELEASE_TOKEN` |
| 发布 PR 合并后没有打 tag | 合并提交的构建失败、被取消，或者排队时被后面的推送替换了 | 在 Actions 里重跑这次合并提交的构建，tag job 会补打 |
| `tag` 输出 `skip … unchanged` | 这次提交不是发布 PR 的合并提交 | 正常 |
| `already points at <sha>` | 同名 tag 指向了别的提交 | 不要移动 tag，先查清楚是谁打的 |
| 发布 PR 版本号或比较起点不对 | 上次发布的 tag 不存在，或者 tag 格式和配置不一致（`component`、`include-component-in-tag`、`tag-separator`） | 让 tag 名和 `release-kit.json` 的 `tagPrefix` 一致，关掉错误的发布 PR，再推一次 |
| 发布 PR 的检查显示 `action_required` | 机器人开的 PR 需要人工批准才会运行 | 不影响发版。合并后会在 main 上完整构建 |
| `check` 报 `base … is not in this clone` | 浅克隆 | 检出时设 `fetch-depth: 0` |
| `check` 拦下了历史提交 | base 太早 | 只检查新提交，不改写已经推送的历史 |
