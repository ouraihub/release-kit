# release-kit

[![CI](https://github.com/ouraihub/release-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ouraihub/release-kit/actions/workflows/ci.yml)

给 GitHub 项目用的标准发布流程：

- **发布 PR**：按 Conventional Commits 自动维护版本号和中文 `CHANGELOG.md`（基于 [release-please](https://github.com/googleapis/release-please)）。合并这个 PR 就是发版。
- **编一次，复用发布**：合并后的提交照常构建；构建成功后 `tag` 给这个提交打 tag，发布工作流直接使用这次构建的产物，不重新编译。
- **提交与注释检查**：提交信息要短而准，并且提交和代码里不出现参考或对标项目名。

不需要安装 npm 包，接入只用复合 Action，初始化只跑一次 `npx`。

## 接入

```bash
npx github:ouraihub/release-kit init --version 0.2.1 --component desktop \
  --version-file desktop/package.json \
  --version-file desktop/src-tauri/Cargo.toml \
  --version-file desktop/src-tauri/Cargo.lock \
  --forbid SomeReferenceApp --forbid 对标
```

生成的文件（已经存在的不会覆盖）：

| 文件 | 作用 |
|---|---|
| `release-please-config.json` | 版本文件、中文分组、tag 格式 |
| `.release-please-manifest.json` | 当前已发布的版本，以后由发布 PR 更新 |
| `release-kit.json` | `tagPrefix` 和 `forbidden` 禁用词 |
| `.github/workflows/release-kit.yml` | 每次推送检查，在 main 上维护发布 PR |

`--version` 填已经发布的版本，并且对应的 tag（比如 `desktop-v0.2.1`）必须已经存在，CHANGELOG 从这个 tag 之后开始生成。

仓库设置里打开 **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**，否则发布 PR 建不出来。

## 构建成功后打 tag

在项目已有的构建工作流末尾加一个 job。它只在发布 PR 的合并提交上真正打 tag，其他提交都直接跳过：

```yaml
  tag:
    needs: build            # 你的构建 job，所有平台成功后才会运行
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 2
      - uses: ouraihub/release-kit/tag@v0
        with:
          token: ${{ secrets.RELEASE_TOKEN }}
```

`token` 必须是 PAT 或 GitHub App token。用 `GITHUB_TOKEN` 创建的 tag 不会触发其他工作流，也就不会触发 `on: push: tags` 的发布工作流。

发布工作流用 `release-kit notes <版本>` 取出这一版的 CHANGELOG 段落，作为发布说明：

```bash
npx --yes github:ouraihub/release-kit#v0 notes "$VERSION"
```

## AI 审查与自动合并

每个 PR 由模型按固定 base 提交的根 `AGENTS.md` 审查（没有就看正确性和安全）。分批发现候选，再按候选补充只读源码并独立复核；仅证据充分的新增缺陷／明确规则违规阻塞，一般建议仅评论。通过后开启自动合并，仍等待所有必需检查。新建 `.github/workflows/ai-review.yml`：

```yaml
name: AI review

# pull_request_target runs this file from main, so a PR cannot weaken its own review.
# PR code is never checked out or executed; the diff is only read as text.
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    name: AI review
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - uses: ouraihub/release-kit/review@v0
        with:
          base-url: ${{ secrets.AI_BASE_URL }}
          api-key: ${{ secrets.AI_API_KEY }}
          model: ${{ vars.AI_MODEL }}
          merge-token: ${{ secrets.RELEASE_TOKEN }}
```

仓库需要：

- secrets `AI_BASE_URL`、`AI_API_KEY`、`RELEASE_TOKEN`，变量 `AI_MODEL`。`RELEASE_TOKEN` 必须是 PAT：用 `GITHUB_TOKEN` 合并不会触发 main 上的工作流。
- Settings → General 勾选 **Allow auto-merge** 和 **Automatically delete head branches**。
- main 分支保护：要求 PR，必需检查填 CI 的 job 名和 `AI review`。没有分支保护时 `--auto` 会立即合并，CI 形同虚设。

审查器从事件固定 head SHA，拉取 base/head 并本地计算完整变更，文件数量不受 GitHub diff API 限制。提交变化、模型/API/JSON 错误或上下文不足标记为 `incomplete` 并禁止合并，不谎称发现代码缺陷。报告记录 base/head；只有通过时输出 `reviewed-head-sha`，自动合并使用 `--match-head-commit` 再校验。fork PR 失败关闭；release-please 的发布 PR 不在这里合并。

生成文件不因 `linguist-generated` 标注而免审；所有实际补丁都进入审查。单文件或完整输入超过安全上限时明确未完成，不把“CI 应该验证生成器”当成已验证事实。

审查分为两阶段：所有 diff 批次先给候选，多批 PR 随后强制执行包含全部原始补丁的跨批一致性扫描，即使局部零候选也不跳过；再统一复核候选。候选复核可申请固定提交的相关文件或行范围，不执行 PR 代码。阻塞意见必须有准确位置、触发条件、实际影响、可对照原文的证据；规则违规还必须引用可信 base 规则。复核可保留阻塞、降为建议或驳回。全部输入超过上限则未完成，不截断后放行。

代码上下文的 `side: base` 指三点 diff 的 merge-base，`side: head` 指事件 head；可信规则独立读取目标分支 base SHA。目标分支推进后旧侧行号仍与补丁一致，不把 target tip 的内容误作删除前证据。

上下文请求有明确轮数、文件大小、总输入量和候选数量上限；触顶为未完成，不截断后放行。置信度分数不作为正确性证明。鉴权、数据完整性及必需检查的行为保证不得降低，但等效测试重写不按断言或步骤数量机械否决；修改授权政策仍须独立可信审批。

普通请求最多 300,000 字符，全局一致性请求最多 500,000 字符，整次累计最多 6,000,000 字符；这些是显式安全上限，不是模型 token 容量保证。合法请求遇到不存在文件或越界行号时，返回 unavailable 供模型在原两轮预算内更正，不默默截断；仍缺上下文则未完成。

直接调用 `review` 命令用于 CI 时必须提供含 PR 编号和 head SHA 的 `GITHUB_EVENT_PATH`。模型只能建议受限的 Git blob 读取；PR 描述、diff 和源码均为不可信数据，不能授权新权限，也不允许模型执行 shell。

### 主干批准的只读权限例外

默认仍拒绝扩大 CI 权限。需要读取历史 Actions 结果时，可先通过独立 PR 在目标仓库 `main` 合入根目录 `release-kit-review.json`：

```json
{
  "permissionExceptions": [
    { "workflow": ".github/workflows/ci.yml", "job": "reuse", "permission": "actions", "level": "read" }
  ]
}
```

审查器从 GitHub 的 `main` tree 定位文件，再按不可变 blob SHA 读取；不信任当前 PR 的同名文件、PR 描述、评论或本地 checkout。仅支持精确工作流／任务的 `actions: read`，不支持通配符、写权限或自由提示词。没有文件时没有例外；配置非法或 API 失败则审查失败，不降级放行。

顺序：先部署支持本策略的 release-kit 版本；再单独审查合入目标仓库的配置；最后重新审查申请权限的功能 PR。新增配置不会授权它所在的 PR。例外只是权限上限，仍须审查最小权限、代码安全及所有必需检查，不允许借例外削弱审查或检查。

首次新增配置按“未来安全策略提案”审查，不要求主干已经存在同一例外，否则无法初始化。配置提案本身不授予令牌权限，审查其精确范围、只读最小权限及安全影响；同一 PR 仍不能用新增配置批准自己的工作流提权。工作流实际提权必须等独立配置 PR 先合入主干。

## 规则

提交信息：

```
<type>(<scope>): <摘要>

[可选正文：只写 diff 看不出来的原因，最多 6 行]
```

1. 一条提交只做一件事。如果标题要用"和"、逗号或斜杠连接几件事，就拆开提交。
2. 标题不超过 72 个字符，结尾不加句号。
3. `feat`、`fix`、`perf`、`revert` 的标题会原样写进 CHANGELOG，所以写用户能感知到的效果，不写实现细节。
4. 不写文件列表、字段清单、验证记录（`Verified:`、`验证：`、`测试通过`），也不写 AI 署名（`Co-authored-by: Claude`、`Generated with …`）。这些在 diff、CI 和 PR 里都已经有了。
5. 不出现 `forbidden` 里的词。来源和对标写进设计文档，不写进提交和代码。
6. 破坏性变更用 `feat!:` 或 `BREAKING CHANGE:` 脚注说明。

版本号规则：`fix`/`perf` 升 patch，`feat` 在 1.0 之前也升 patch、1.0 之后升 minor，破坏性变更在 1.0 之前升 minor、1.0 之后升 major。

代码：被 git 跟踪的文件里，除 `*.md`、锁文件和 `release-kit.json` 中 `ignore` 列出的路径外，都不能出现 `forbidden` 里的词（不区分大小写，按子串匹配）。

本地检查当前分支相对上游的新提交：

```bash
npx github:ouraihub/release-kit check
```

## 给大模型用

[`skills/release-kit/SKILL.md`](skills/release-kit/SKILL.md) 是给 AI 编码助手的使用说明，包括提交规则、正反例、发版、接入新项目和常见失败的排查。把它放进助手能读取的 skills 目录：

```bash
# Claude Code 项目级；用户级放 ~/.claude/skills/release-kit/
mkdir -p .claude/skills/release-kit
curl -fsSL https://raw.githubusercontent.com/ouraihub/release-kit/v0/skills/release-kit/SKILL.md -o .claude/skills/release-kit/SKILL.md
```

不支持 skills 的助手，在 AGENTS.md 里加一行：`提交和发布规则见 https://github.com/ouraihub/release-kit/blob/main/skills/release-kit/SKILL.md`。

## 版本

用 `@v0` 引用会跟随 0.x 的最新版本。想锁定具体版本，就引用某个 tag 或 commit。

## 许可

MIT
