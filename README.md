# dsh-repo

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的代码仓库插件。它用 GitHub 官方 SDK [Octokit](https://github.com/octokit/rest.js) 和 GitLab 文档推荐的 [GitBeaker](https://github.com/jdalrymple/gitbeaker) 抹平 GitHub 与 GitLab 的差异，对其他插件提供 `dshRepos` 服务，对模型提供代码、issue、PR/MR 工具；需要本地代码目录的插件可以用它维护仓库的本地镜像和按提交的只读快照。

支持的主机：github.com、GitHub Enterprise Server、gitlab.com、自建 GitLab（包括部署在子路径下的实例）。

## 项目状态

测试版：提供统一接口、模型工具、运行时主机管理、本地镜像和 Web 设置页。接口仍可能调整。

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
    mirror:
      dir: ~/.dsh/dsh-repo/mirrors      # 本地镜像目录，默认 $DSH_HOME/dsh-repo/mirrors
      gitTimeoutMs: 600000              # 单条 git 命令（clone、fetch、worktree）的超时
      otherHosts: true                  # false = 只镜像 hosts 中主机上的仓库
    hostsFile: ~/.dsh/dsh-repo/hosts.json  # 运行时添加的主机，默认 $DSH_HOME/dsh-repo/hosts.json
    tools:
      enabled: true                     # false = 只提供 dshRepos 服务，不注册模型工具
      writes: ask                       # ask：每次写操作请用户审批；allow：不审批；off：不注册写工具
      merge: false                      # true 才注册合并工具（仍按 writes 审批）
      signature: ''                     # 非空时追加到模型写的 issue、PR/MR 正文和评论末尾
```

配置在加载时校验，不合法时插件加载失败；`hostsFile` 存在但无法读取或内容不合法时同样加载失败。没有任何主机时模型看不到代码仓库工具，添加主机后立即提供。

### 运行时添加主机

除了 cordis.yml 里的 `hosts`，还可以在运行时添加主机：Web 组合中打开左侧栏「插件」，进入 dsh-repo 的详情页即可添加、删除主机和保存、清除令牌，改动立即生效；其他插件也可以调用 `addHost` 添加主机、`removeHost` 删除、`setHostToken` 保存或清除令牌。添加的主机保存在 `hostsFile`，令牌存入 DSH 凭据库，引用名由地址生成（`DSH_REPO_HOST_<哈希>`）。cordis.yml 中的主机只能改令牌，不能在运行时删除；`listHosts` 列出所有主机及令牌是否已设置，不返回令牌值。`onHostsChange` 在每次主机或令牌变更成功后通知监听者，例如需要在令牌更新后重新拉取镜像的插件。

设置页的数据来自宿主 `webServer` 上的 `/dsh-repo/state`、`/dsh-repo/hosts`、`/dsh-repo/host-token` 路由，请求经宿主 `connection` 做与 DSH `/api` 相同的来源校验和登录鉴权，写操作另外要求同源。没有 Web 的组合不挂载这些路由。

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

接口覆盖仓库信息、分支、提交、目录、文件、多文件提交、issue 与 PR/MR 的读写和合并，以及主机管理和本地镜像，完整定义见 [`src/contract.ts`](src/contract.ts)。多文件提交可以用 `baseSha` 从指定提交建新分支，`newBranch: true` 时分支已存在就以 `conflict` 失败，不会在已有分支上追加提交；`author` 指定提交作者（提交者始终是令牌对应的用户）。`getBranch` 读取单个分支，分支不存在时返回 `undefined`。所有预期内的失败都以 `name === 'RepoError'` 的错误拒绝，`code` 取值为 `invalid`、`not-allowed`、`unauthenticated`、`forbidden`、`not-found`、`conflict`、`rate-limited`、`too-large`、`unavailable`。

## 本地镜像

`syncMirror(url, { branch })` 把仓库拉取为只拉取、不检出的镜像，返回分支最新提交；`readMirrorFile`、`listMirrorTree` 直接从提交的 git 对象读文件和目录；`acquireSnapshot(url, commit)` 返回该提交的只读检出（`git worktree`），同一提交的持有者共用一份，全部 `release()` 且不再是最近一次同步的提交时删除。

- `mirror.dir` 默认是 `$DSH_HOME/dsh-repo/mirrors`，一般不用配置。镜像和运行时添加的主机都在 DSH 主目录下，不在插件的安装目录里，升级、卸载或重装插件不会删除它们；改动 `mirror.dir` 后旧目录里的镜像不会搬过去，下次使用时在新目录重新克隆。
- 镜像位于 `<mirror.dir>/<主机>/<路径>`，本地路径位于 `<mirror.dir>/local/`；快照位于 `<mirror.dir>/.snapshots/` 下对应位置。新地址先克隆到临时目录再改名；同一镜像的 clone/fetch 依次执行。进程内第一次同步某个镜像时清理上次运行遗留的快照。
- 地址可以是 HTTPS/SSH/git/file URL、`user@host:path` 或绝对路径。属于已配置主机的地址受 `repos` 范围限制；其中 HTTPS 地址自动使用该主机的令牌（GitLab 用户名 `oauth2`，GitHub 用户名 `x-access-token`），令牌经只对这次 git 进程生效的凭据助手传入，不出现在命令行、`.git/config` 或输出里。SSH 地址、其他主机和本地路径使用本机已有的 git 凭据（SSH key、凭据助手），`mirror.otherHosts: false` 时拒绝其他主机。
- 需要本机安装 `git`；git 不会弹出交互式提示，SSH 以 batch 模式运行。

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
pnpm check    # 类型检查、测试、构建、Host 与 client 加载校验
```

`src/client` 是浏览器端代码，单独用 `tsconfig.client.json` 检查，打包成 `lib/client.js` 经 DSH 的 `__ModuleLoader__` 加载，react 来自 Web 外壳的模块表。

测试用替换全局 `fetch` 的方式驱动真实的 Octokit 和 GitBeaker，不访问网络。
