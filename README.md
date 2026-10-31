# dsh-repo

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的代码仓库插件。它用 GitHub 官方 SDK [Octokit](https://github.com/octokit/rest.js) 和 GitLab 文档推荐的 [GitBeaker](https://github.com/jdalrymple/gitbeaker) 抹平 GitHub 与 GitLab 的差异，对其他插件提供 `dshRepos` 服务，对模型提供代码、issue、PR/MR 工具。

支持的主机：github.com、GitHub Enterprise Server、gitlab.com、自建 GitLab（包括部署在子路径下的实例）。

## 项目状态

初版（未发布到 npm）：提供统一接口和模型工具。仓库镜像、只读快照（观象现在自带的 git 能力）计划在后续版本迁入。接口仍可能调整。

## 安装

```bash
# 在 deepseek-harness 仓库内
pnpm build   # 本地 checkout 需要先构建
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh-repo
```

包内的 `cordis.patch.yml` 把 `dsh-repo` 加入 profile 的 bundle 列表，Loader 行的稳定 id 是 `dsh-repo`。插件需要宿主提供 `tools` 和 `credentials` 服务；写操作审批使用 `approval` 服务（`@deepseek-ai/dsh-user-approval`），dsh-channels 会把审批渲染成飞书卡片。

## 配置

```yaml
- id: dsh-repo
  config:
    hosts:
      - kind: github
        url: https://github.com
        tokenRef: GITHUB_TOKEN          # DSH 凭据库中的令牌名称，也可以是同名环境变量；不是令牌本身
      - kind: github                    # GitHub Enterprise Server：接口地址默认 <url>/api/v3
        url: https://ghe.example.com
        tokenRef: GHE_TOKEN
        # apiUrl: https://ghe.example.com/api/v3
      - kind: gitlab                    # 自建 GitLab，可带子路径
        url: https://code.example.com/gitlab
        tokenRef: GITLAB_TOKEN
    repos:                              # 可访问的仓库；省略或为空 = 上面主机上令牌能访问的全部仓库
      - github.com/modestoma/*          # * 匹配一层
      - code.example.com/team/**        # ** 匹配任意多层（GitLab 子组）
    timeoutMs: 30000                    # 单次调用的超时
    limits:
      perPage: 30                       # 列表默认每页条数
      maxPerPage: 100
      maxFileBytes: 1048576             # 读文件、提交单文件的上限
      maxDiffBytes: 524288              # diff 的上限，超出截断
      maxTreeEntries: 1000              # 目录列表的上限，超出截断
      maxCommitFiles: 100               # 一次提交的文件数上限
      maxComments: 50                   # 读取 issue / PR/MR 时附带的评论条数
    tools:
      enabled: true                     # false = 只提供 dshRepos 服务，不注册模型工具
      writes: ask                       # ask：每次写操作请用户审批；allow：不审批；off：不注册写工具
      merge: false                      # true 才注册合并工具（仍按 writes 审批）
      signature: ''                     # 非空时追加到模型写的 issue、PR/MR 正文和评论末尾
```

配置在加载时校验，不合法时插件加载失败。没有配置任何主机时只提供服务，不注册工具。

### 令牌

令牌每次请求时经 `ctx.credentials` 读取（环境变量 > `$DSH_HOME/.credentials.yaml` > `.env`），更换令牌不用重启。GitHub 需要 `repo`（或细粒度令牌的 Contents、Issues、Pull requests 读写）权限；GitLab 需要 `api` 权限，只读使用可以用 `read_api`。令牌只出现在发往该主机的请求头里，不进入模型上下文。

与 DSH 中的模型 API Key 一样，Agent 的命令以同一系统用户运行，文件权限不能把令牌与 Agent 隔离；建议使用权限最小、设置了过期时间的令牌，并用 `repos` 限定范围。

### 网络代理

两个 SDK 都使用 Node 内置的 `fetch`，它默认不读取 `HTTPS_PROXY`。需要经代理访问时，用支持 `NODE_USE_ENV_PROXY=1` 的 Node 版本启动 dsh。

## 模型工具

所有工具的 `repo` 参数接受仓库网址、git 地址或 `主机/路径`；PR/MR 页面的网址也可以直接粘贴。编号是网页上显示的编号（GitLab 的 IID）。

| 工具 | 作用 | 审批 |
|---|---|---|
| `repo_info` | 默认分支、可见性、描述、克隆地址 | 否 |
| `repo_list_branches` / `repo_list_commits` | 分支、提交历史 | 否 |
| `repo_list_tree` / `repo_read_file` | 目录与文件内容 | 否 |
| `repo_issue_list` / `repo_issue_get` | issue 列表、单个 issue 及评论 | 否 |
| `repo_mr_list` / `repo_mr_get` / `repo_mr_diff` / `repo_mr_status` | PR/MR 列表、详情与评论、diff、CI 与可合并状态 | 否 |
| `repo_commit_files` | 一次提交多个文件的写入和删除；分支不存在时从 `base` 创建 | 是 |
| `repo_issue_create` / `repo_issue_update` / `repo_issue_comment` | 创建、修改、关闭或重开、评论 issue | 是 |
| `repo_mr_create` / `repo_mr_update` / `repo_mr_comment` | 创建（可为草稿）、修改、关闭或重开、评论 PR/MR | 是 |
| `repo_mr_merge` | 按 `headSha` 合并，head 已变化时拒绝；默认不注册 | 是 |

- 写操作在 `writes: ask` 下每次调用都经 `ctx.approval` 请用户确认一次，被拒绝时工具返回 `{ "status": "declined" }`，不会调用主机。组合里没有审批服务时写工具报错。
- `repo_commit_files` 不允许提交到默认分支或受保护分支；改代码的流程是提交到新分支，再用 `repo_mr_create` 开 PR/MR。
- 失败时工具报错，消息以失败类型开头，例如 `[not-found]`、`[forbidden]`、`[conflict]`。

## `dshRepos` 服务

其他插件经 `ctx.get('dshRepos')` 取得服务，类型从 `dsh-repo/contract` 用 `import type` 引入，调用前检查 `version`：

```ts
import type { DshRepoService } from 'dsh-repo/contract'

const repos = ctx.get('dshRepos') as DshRepoService | undefined
if (repos?.version === 1) {
  const issue = await repos.getIssue('https://gitlab.example.com/team/orders', 12)
}
```

接口覆盖仓库信息、分支、提交、目录、文件、多文件提交、issue 与 PR/MR 的读写和合并，完整定义见 [`src/contract.ts`](src/contract.ts)。多文件提交可以用 `baseSha` 从指定提交建新分支，`newBranch: true` 时分支已存在就以 `conflict` 失败，不会在已有分支上追加提交；`author` 指定提交作者（提交者始终是令牌对应的用户）。`getBranch` 读取单个分支，分支不存在时返回 `undefined`。所有预期内的失败都以 `name === 'RepoError'` 的错误拒绝，`code` 取值为 `invalid`、`not-allowed`、`unauthenticated`、`forbidden`、`not-found`、`conflict`、`rate-limited`、`too-large`、`unavailable`。

## GitHub 与 GitLab 的差异处理

| 差异 | 处理 |
|---|---|
| 仓库路径 | GitHub 固定 `owner/name`；GitLab 允许多级子组 |
| 编号 | 统一为网页上的编号：GitHub number、GitLab IID |
| PR/MR 状态 | 统一为 `open` / `closed` / `merged`；GitHub 的 merged 由 `merged_at` 判断 |
| 草稿 | GitHub 用 `draft` 字段；GitLab 创建时加 `Draft: ` 标题前缀 |
| 指派人 | 统一用用户名；GitLab 先查用户 id |
| 多文件提交 | GitHub 用 Git Data API（tree → commit → ref），保留已有文件的可执行位；GitLab 用 Commits API，按文件是否存在选择 create / update |
| CI 状态 | GitHub 合并 check runs 与 commit statuses；GitLab 读 MR 的 head pipeline |
| 合并方式 | GitHub 支持 merge / squash / rebase；GitLab 支持 merge / squash |

## 已知限制

- GitBeaker 不接受逐次调用的取消信号，GitLab 请求只受 `timeoutMs` 约束；调用被取消后，已发出的请求可能仍会完成。
- 修改 PR/MR 时不能切换草稿状态；GitHub 的行内评审评论、评审（approve / request changes）不在第一版范围内。
- issue 列表不支持全文搜索。
- 不提供删除分支、删除仓库、修改仓库设置等操作。

## 开发

```bash
pnpm install
pnpm check    # 类型检查、测试、构建、加载校验
```

测试用替换全局 `fetch` 的方式驱动真实的 Octokit 和 GitBeaker，不访问网络。
