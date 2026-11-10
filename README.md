# dsh-repo

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的代码仓库插件。它用 GitHub 官方 SDK [Octokit](https://github.com/octokit/rest.js) 和 GitLab 文档推荐的 [GitBeaker](https://github.com/jdalrymple/gitbeaker) 抹平 GitHub 与 GitLab 的差异，对模型提供代码、issue、PR/MR 和 CI（流水线、作业日志）工具，对其他插件提供一一对应的 `dshRepos` 服务方法；改代码用的工作区是一份普通的 git 克隆，Agent 在里面用平常的 git 命令工作，经插件在 127.0.0.1 上的 git 代理访问远端，令牌不进入工作区。插件还维护仓库的本地裸镜像、按提交的只读快照，也可以把仓库分支定时展开到本机任意目录（本地同步）。能访问哪些仓库、每个仓库的权限、为哪些仓库打开其他插件的功能，都只在 dsh-repo 的[仓库清单](#仓库清单)里配置。

支持的主机：github.com、GitHub Enterprise Server、gitlab.com、自建 GitLab（包括部署在子路径下的实例）。

## 项目状态

测试版：提供统一接口（服务版本 7）、模型工具、运行时主机管理、仓库清单、本地镜像、工作区与本机 git 代理、PR/MR 跟踪、本地同步和左侧栏「代码仓库」设置页。接口仍可能调整。

## 安装

```bash
# 在 deepseek-harness 仓库内
pnpm build   # 本地 checkout 需要先构建
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh-repo
```

包内的 `cordis.patch.yml` 把 `dsh-repo` 加入 profile 的 bundle 列表，Loader 行的稳定 id 是 `dsh-repo`。插件需要宿主提供 `tools` 和 `credentials` 服务；写操作审批使用 `approval` 服务（`@deepseek-ai/dsh-user-approval`），渠道插件可以把审批渲染成自己的界面（例如飞书卡片）；写操作还先经 `access/authorize` 事件问过其他插件（见[授权事件](#授权事件)）。[PR/MR 跟踪](#跟踪-prmr)需要 `sessionController` 服务（Web 和桌面组合都有）来唤醒会话。

## 配置

所有参数都在 Web 组合左侧栏的「代码仓库」页面配置，保存在设置文件（默认 `$DSH_HOME/dsh-repo/hosts.json`）中，不在插件安装目录里，升级、卸载或重装插件都不会清空。cordis.yml 只保留两项：

```yaml
- id: dsh-repo
  config:
    hosts:                              # 可选：随 profile 预置的主机，在设置页只读显示、只能改令牌
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
    hostsFile: ~/.dsh/dsh-repo/hosts.json  # 设置文件位置，默认 $DSH_HOME/dsh-repo/hosts.json
```

cordis.yml 在加载时校验，写入其他键（例如以前的 `repos`、`limits`、`tools`、`mirror`、`timeoutMs`）时插件加载失败；设置文件存在但无法读取或内容不合法时同样加载失败。设置文件里旧版本的 `settings.repos`（访问范围）、`settings.mirror.otherHosts` 和 `settings.tools.merge` 已由仓库清单取代：加载时忽略并记一条警告，下次保存设置文件时删除；原来的访问范围不会转换成清单条目，请在「仓库」标签页重新添加仓库。

### 设置页

| 标签页 | 设置 | 默认 | 保存方式 |
|---|---|---|---|
| 主机 | 添加（类型、地址、GitHub 接口地址、别名、令牌）、删除主机，保存或清除令牌 | 无 | 立即 |
| 高级 | 镜像目录（必须设置；不能在 `$DSH_HOME` 或 `/tmp` 下） | 无 | 立即 |
| 高级 | 镜像占用：镜像目录里每个仓库占用的空间和最近拉取时间，以及快照和其他文件的合计（只读） | — | — |
| 仓库 | 添加、修改、删除清单中的仓库：地址、基线分支、权限、功能开关和各自的分支、本地同步（开关、本地目录、分支、间隔）、分支命名；镜像拉取状态和重新拉取；立即同步。见[仓库清单](#仓库清单) | 空；间隔默认 12 小时 | 立即 |
| 工作区 | dsh-repo 建的所有工作区：仓库、当前分支和基线分支、未提交的文件数、只在本机的提交数、这个分支上打开中的 PR/MR、最近 git 活动；新建、在此新建会话、删除。见[从设置页新建工作区](#从设置页新建工作区) | 无 | 立即 |
| 高级 | 工作区目录：「工作区」标签页新建的工作区放在这里，不存在会创建 | 无 | 立即 |
| 模型工具 | `tools.enabled`：是否提供 `repo_*` 工具 | 提供 | 保存条 |
| 模型工具 | `tools.writes`：`ask` 每次审批、`allow` 不审批、`off` 关闭所有写操作（不提供写工具，服务调用、设置页和工作区里的 `git push` 也一律拒绝） | `ask` | 保存条 |
| 模型工具 | `tools.deleteSourceBranch`：合并后删除源分支，见[合并后的分支](#合并后的分支) | 删除 | 保存条 |
| 模型工具 | `tools.signature`：追加到模型写的正文和评论末尾 | 空 | 保存条 |
| MR 跟踪 | `watch.enabled`：是否跟踪 PR/MR，见[跟踪 PR/MR](#跟踪-prmr) | 跟踪 | 保存条 |
| MR 跟踪 | `watch.events`：每类动态的处理方式，`wake` 唤醒、`note` 只记录、`off` 忽略 | 见下文 | 保存条 |
| MR 跟踪 | `watch.activeIntervalMs` / `quietAfterMs` / `quietIntervalMs`：检查间隔、多久没动态算安静、安静时的间隔 | 60 秒 / 60 分钟 / 10 分钟 | 保存条 |
| MR 跟踪 | `watch.batchMs`：合并通知窗口 | 120 秒 | 保存条 |
| MR 跟踪 | `watch.idleDays` / `dailyWakeLimit` / `maxWatches`：无动态停止跟踪、每个 PR/MR 每天唤醒上限、同时跟踪上限 | 7 天 / 10 次 / 50 个 | 保存条 |
| MR 跟踪 | 正在跟踪的 PR/MR，每个可以停止 | 无 | 立即 |
| 高级 | `timeoutMs`：一次接口调用 | 30 秒 | 保存条 |
| 高级 | `mirror.gitTimeoutMs`：一条 git 命令（clone、fetch、push） | 600 秒 | 保存条 |
| 高级 | `workspace.proxyPort`：本机 git 代理的端口，见[改代码](#改代码)；0 表示自动选一个空闲端口并一直沿用 | 0 | 保存条 |
| 高级 | `workspace.commitName` / `commitEmail`：工作区默认的提交身份；主机令牌账号读不到时作为提交者 | 空（用令牌账号） | 保存条 |
| 高级 | `workspace.branchTemplate` / `branchPattern`：新工作区的分支命名模板和分支名规则，仓库可以单独设置，见[分支命名](#分支命名) | `dsh/{session}` / 空（不限） | 保存条 |
| 高级 | `limits.perPage` / `maxPerPage` / `maxComments` / `maxTreeEntries` | 30 / 100 / 50 / 1000 | 保存条 |
| 高级 | `limits.maxFileBytes` / `maxDiffBytes`：读文件上限、diff 截断 | 1 MiB / 512 KiB | 保存条 |
| 高级 | `limits.maxLogBytes`：一次返回的 CI 作业日志片段上限，也是一条流水线所有失败信息合计的上限 | 32 KiB | 保存条 |
| 高级 | `limits.maxCiFailures`：读取流水线时附带的失败用例或错误注解条数 | 50 | 保存条 |

「立即」的改动点击即保存；其余设置改动后页面底部出现保存条，每项改过时旁边有「恢复默认」。保存后的设置从下一次调用开始生效，不用重启：工具在模型的下一步按新设置提供或隐藏，已经提供的写工具在写操作被关闭后拒绝执行。设置文件的 `settings` 字段只记录与默认不同的项，「全部恢复默认」删除该字段；以后版本调整默认值时，没改过的项随之变化。「插件 → dsh-repo」页面只保留一个指向该入口的「打开设置」按钮。

仓库清单为空（或清单里的仓库都不在已配置的主机上）时不提供任何工具，管理员在设置页添加仓库后立即提供。仓库只能在设置页添加，模型和其他插件都不能改清单。

### 运行时添加主机

除了 cordis.yml 里的 `hosts`，还可以在设置页添加、删除主机和保存、清除令牌，改动立即生效；其他插件也可以调用 `hostAdd` 添加主机、`hostRemove` 删除、`hostSetToken` 保存或清除令牌。添加的主机保存在设置文件，令牌存入 DSH 凭据库，引用名由地址生成（`DSH_REPO_HOST_<哈希>`）。cordis.yml 中的主机只能改令牌，不能在运行时删除；`hostList` 列出所有主机及令牌是否已设置，不返回令牌值。`hostOnChange` 在每次主机、令牌或镜像目录变更成功后通知监听者，例如需要在令牌更新后重新拉取镜像的插件。

设置页的数据来自宿主 `webServer` 上的 `/dsh-repo/state`、`/dsh-repo/hosts`、`/dsh-repo/host-token`、`/dsh-repo/mirror`、`/dsh-repo/settings`、`/dsh-repo/watches`、`/dsh-repo/repos`、`/dsh-repo/repos/sync`、`/dsh-repo/repos/fetch`、`/dsh-repo/repos/branches`、`/dsh-repo/workspaces`、`/dsh-repo/workspace-dir` 路由，请求经宿主 `connection` 做与 DSH `/api` 相同的来源校验和登录鉴权，写操作另外要求同源。没有 Web 的组合不挂载这些路由。

### 令牌

令牌每次请求时经 `ctx.credentials` 读取（环境变量 > `$DSH_HOME/.credentials.yaml` > `.env`），更换令牌不用重启。GitHub 需要 `repo`（或细粒度令牌的 Contents、Issues、Pull requests 读写）权限，CI 工具另需细粒度令牌的 Actions 权限（读；重试、取消要写）和 Checks 读权限，classic 令牌的 `repo` 已包含；GitLab 需要 `api` 权限，只读使用可以用 `read_api`，读作业日志要求令牌账号在项目里至少是 Reporter，重试、取消至少是 Developer。令牌只出现在发往该主机的请求头和 git 进程的凭据助手里，不进入模型上下文。镜像拉取和代理转发推送用的也是这个令牌（GitLab 的 `api` 权限包含推送）。

与 DSH 中的模型 API Key 一样，Agent 的命令以同一系统用户运行，文件权限不能把令牌与 Agent 隔离；建议使用权限最小、设置了过期时间的令牌，并只把需要的仓库加入清单。

### 网络代理

两个 SDK 和本机 git 代理的推送转发都使用 Node 内置的 `fetch`，它默认不读取 `HTTPS_PROXY`。需要经代理访问时，用支持 `NODE_USE_ENV_PROXY=1` 的 Node 版本启动 dsh。镜像的 clone/fetch 由 git 进程执行，读取 git 自己的代理设置。

## 仓库清单

仓库清单是 dsh-repo 能访问的全部仓库。清单之外的仓库一律拒绝，读也不行：模型工具、`dshRepos` 服务调用、本地镜像、快照、工作区和代理、PR/MR 跟踪和 CI 工具对清单外的仓库都以 `not-allowed` 失败，错误说明请管理员在「代码仓库 → 仓库」中添加。清单保存在设置文件的 `repos` 字段，在设置页「仓库」标签页编辑，改动立即生效，不用重启。

每个仓库有这些设置：

| 设置 | 说明 |
|---|---|
| 地址 | HTTPS 地址，必须在已配置的主机上；本机路径和 `file:` URL 不支持，设置文件里旧版本留下的这类条目在加载时忽略并记日志，下次保存时删除。同一仓库只能出现一次：按小写的仓库网页地址（主机、主机的路径前缀、仓库路径）比较，所以网页地址、`.git` 地址、SSH 地址和大小写不同的写法算同一个仓库，同一域名下不同路径前缀的两个 GitLab 实例的仓库不会混淆 |
| 基线分支 | 改代码的起点和终点：新工作区从它的最新提交拉出新分支，PR/MR 默认合回它，不带 `ref` 的快照也取它。留空是远端默认分支。只在发版分支上开发的仓库留空即可；在 `dev` 上开发、`main` 发版的仓库填 `dev` |
| 权限 | 「只读」只能读（包括快照，以及在本地工作区里修改但不能推送）；「可改代码」还能创建和评论 issue、PR/MR，推送工作区，重试和取消 CI，删除已合并分支；「可合并」还能合并 PR/MR |
| 功能 | 其他插件运行时注册的功能（例如日志分析插件注册「日志分析」），每个仓库单独开关，打开的功能可以选一个分支（例如日志分析读 `main`），留空跟基线分支一致；dsh-repo 只保存开关和分支，功能本身由注册它的插件实现。清单里有、但当前没有插件注册的功能照样保留，设置页以功能 id 显示并注明注册它的插件没有加载 |
| 本地同步 | 开关、本地目录、分支（留空跟基线分支一致）和同步间隔，见[本地同步](#本地同步) |
| 分支命名 | 这个仓库的分支命名模板和分支名规则，留空用全局设置，见[分支命名](#分支命名) |

- 权限是这个仓库的上限，和其他限制同时生效：写操作仍然要经过 `tools.writes`、`access/authorize` 事件（例如渠道插件按用户或群开关的改代码权限）和用户审批。权限不够时调用以 `not-allowed` 失败，不问用户、不发请求。
- 添加仓库，或改了地址和任一分支时，保存前先用主机令牌执行一次 `git ls-remote`（超时取 `timeoutMs`）：访问不了或令牌被拒时报原因，填的基线分支、功能分支、本地同步分支在远端不存在时指出是哪一项，都不保存。
- 保存后在后台拉取镜像，插件启动时也在后台拉取所有还没拉取过的仓库（镜像目录未设置时不拉取）；换镜像目录或主机、令牌变化后重新拉取。每个仓库显示拉取中、已拉取或拉取失败（带原因和「重新拉取」按钮）。工具、快照和工作区照常在使用前拉取最新内容，这个状态也随之更新；状态只在内存里，重启后重新拉取。
- 模型工具按清单里最高的权限提供：清单里有「可改代码」的仓库才提供写工具，有「可合并」的仓库才提供 `repo_mr_merge`。`repo_list` 列出清单里的仓库、基线分支、权限和功能（带各自的分支），模型据此选择仓库。清单为空时不提供工具。
- 旧版本的条目只有一个「分支」：加载时把它同时作为基线分支、每个功能的分支和本地同步分支，行为不变，记一条日志，下次保存时写成新格式。
- 主机被删除后，清单里它上面的仓库保留，设置页标出原因，调用照样拒绝；重新添加主机后恢复。
- 删除仓库只删除清单条目；本地同步目录里的文件保留，正在跟踪的 PR/MR 在下一次检查时停止跟踪。

## 模型工具

工具名是 `repo_<对象>_<动作>`，对应的服务方法是 `<对象><动作>`（例如 `repo_mr_create` ↔ `mrCreate`，`repo_get` ↔ `repoGet`），两者参数相同、走同一套流程，见[`dshRepos` 服务](#dshrepos-服务)。所有工具的 `repo` 参数接受仓库网址、git 地址或 `主机/路径`；PR/MR 页面的网址也可以直接粘贴。仓库必须在[仓库清单](#仓库清单)里，权限够这次操作。编号是网页上显示的编号（GitLab 的 IID）。

| 工具 | 作用 | 审批 |
|---|---|---|
| `repo_list` | 仓库清单里的仓库：地址、基线分支、权限、功能和功能的分支 | 否 |
| `repo_get` | 默认分支、可见性、描述、克隆地址 | 否 |
| `repo_branch_list` / `repo_branch_get` | 分支列表；单个分支（不存在时为 `null`） | 否 |
| `repo_branch_delete` | 删除已经合并的遗留分支，见[合并后的分支](#合并后的分支) | 是 |
| `repo_commit_list` | 提交历史 | 否 |
| `repo_tree_list` / `repo_file_read` | 经主机接口读目录与文件；浏览整个检出用 `repo_snapshot_acquire` | 否 |
| `repo_issue_list` / `repo_issue_get` | issue 列表（可用 `search` 搜索标题和描述）、单个 issue 及评论 | 否 |
| `repo_issue_create` / `repo_issue_update` / `repo_issue_comment` | 创建、修改、关闭或重开、评论 issue | 是 |
| `repo_mr_list` / `repo_mr_get` / `repo_mr_diff` / `repo_mr_status` | PR/MR 列表、详情与评论、diff、CI 与可合并状态；CI 检查带 `runId` / `jobId` 时可以接着用 CI 工具查看 | 否 |
| `repo_mr_create` / `repo_mr_update` / `repo_mr_comment` | 创建（可为草稿）、修改、关闭或重开、评论 PR/MR；创建时不给目标分支就合回仓库清单里的基线分支，没设基线时合回默认分支；创建和重开的 PR/MR 自动跟踪 | 是 |
| `repo_mr_merge` | 按 `headSha` 合并，head 已变化时拒绝；按设置一并删除源分支；只合并权限为「可合并」的仓库 | 是 |
| `repo_mr_watch` | 让本会话跟踪一个打开中的 PR/MR，或停止跟踪，见[跟踪 PR/MR](#跟踪-prmr)；跟踪可用时才提供 | 否 |
| `repo_ci_list` | CI 运行列表（GitLab 流水线、GitHub Actions workflow run），可按分支或 tag、提交、PR/MR、状态过滤，见[查看 CI](#查看-ci) | 否 |
| `repo_ci_get` | 一次运行的作业、阶段、失败原因、耗时、GitHub 步骤、GitLab 下游流水线；失败的运行附带失败用例或错误注解 | 否 |
| `repo_ci_log` | 作业日志：默认返回末尾，`search` 返回命中行和上下文，可按 `section` 过滤、用 `beforeLine` 往前翻 | 否 |
| `repo_ci_retry` / `repo_ci_cancel` | 重试一次运行的失败作业或单个作业；取消一次运行或单个作业（单个作业只限 GitLab） | 是 |
| `repo_snapshot_acquire` | 某个分支、tag 或提交的只读检出目录（默认清单里的分支）；分支和 tag 先从远端拉取，镜像里已有的完整提交 id 直接使用、不连远端；同一会话对同一仓库再取一次时释放上一份，12 小时后自动释放 | 否 |
| `repo_workspace_create` | 新建工作区并把会话的工作目录切过去，见[改代码](#改代码) | 否 |
| `repo_workspace_list` | 本会话创建的、或在本会话目录里的工作区 | 否 |
| `repo_workspace_status` | 工作区相对起点提交的改动：文件与增删行数、提交、未推送的提交数、diff | 否 |
| `repo_workspace_push` | 提交未提交的改动并推送到工作区的分支，可在没有打开中的 PR/MR 时顺带创建一个；结果列出这个分支上打开中的 PR/MR | 是 |
| `repo_workspace_remove` | 删除工作区目录；有未提交的改动或未推送的提交时要 `force` | 否 |

- 写操作在设置页选「每次审批」（`writes: ask`）时每次调用都经 `ctx.approval` 请用户确认一次，被拒绝时工具返回 `{ "status": "declined", "outcome": "rejected" }`，不会调用主机。组合里没有审批服务时写工具报错。
- 审批提示首行写要做的事，之后每行一项「标签：值」，文件列表缩进两格；审批端按行展示即可。`repo_workspace_push` 列出目标分支、仓库、起点、提交说明首行、要创建的 PR/MR、改动总数与增删行数，以及按改动量排序的前 12 项文件改动，整个目录的移动合并成一行。
- 失败时工具报错，消息以失败类型开头，例如 `[not-found]`、`[forbidden]`、`[conflict]`。
- 工作区的创建和删除、所有写操作不和同一 Agent 的其他工具调用并行执行；读操作可以并行。

## 查看 CI

CI 工具读取 GitLab 流水线和 GitHub Actions。只通过提交状态上报的外部 CI（例如 Jenkins）只能在 `repo_mr_status` 里看到状态和链接，读不到作业和日志。

- **运行列表。** `repo_ci_list` 新的在前。给 `number` 时，GitLab 列出这个 MR 的流水线（状态过滤在读到的这一页上进行），GitHub 列出 PR 当前 head 提交的运行；`number` 不能和 `ref`、`sha` 同时给出。
- **运行详情。** `repo_ci_get` 列出作业（GitLab 按接口顺序，触发下游流水线的作业排在最后；GitHub 只列最近一次尝试的作业），最多读 1000 个，超出时 `jobsTruncated` 为 true。运行失败时再读一次失败信息：GitLab 读流水线的测试报告（需要作业上传 JUnit 报告），返回测试计数和失败、出错的用例；GitHub 读失败作业的错误级注解，通常带文件和行号。最多返回 `maxCiFailures` 条，每条信息截到 `maxLogBytes / maxCiFailures` 字节。测试报告或注解读不到时 `failuresError` 写明原因，作业列表照常返回。GitLab 下游流水线带 `sameRepo`，为 true 时可以用它的 id 在同一个仓库上继续 `repo_ci_get`。
- **作业日志。** `repo_ci_log` 按流读取日志，内存只保留要返回的部分，日志大小只受 `timeoutMs` 约束。读取时去掉颜色等控制字符、只保留用回车重绘的行的最后状态、去掉 GitHub 每行的时间戳，GitLab 的 section 和 GitHub 的 group 变成一行 `▶ 标题`。不给 `search` 时返回日志末尾不超过 `maxLogBytes` 的行，`more` 为 true 表示前面还有，把 `fromLine` 作为 `beforeLine` 再调用一次往前翻；给 `search`（最多 20 个，不区分大小写的普通文本）时按日志顺序返回命中行和前后 `context` 行（默认 3），每行带行号，不相邻的片段用 `--` 分隔，`matches` 是全日志的命中数。`section` 只看标题包含该文本的 section 或 group，`sections` 列出日志里出现过的标题。GitHub 的日志接口重定向到临时存储地址，插件手动跟随，令牌只发给 API 主机；GitHub 要等作业结束才提供日志。
- **重试和取消。** `repo_ci_retry` 给 `runId` 时重试失败作业（GitLab 重试流水线中失败和取消的作业；GitHub 把失败作业和依赖它们的作业作为同一运行的新尝试重跑），给 `jobId` 时重试单个作业（GitLab 生成新的作业 id，在结果的 `jobId` 里）。`repo_ci_cancel` 取消运行或 GitLab 的单个作业；GitHub 不能单独取消作业，以 `invalid` 拒绝。两者跟随写操作审批。
- **日志里的密钥。** GitLab 会遮盖 masked 变量，GitHub 会遮盖 secrets；没有被平台遮盖的内容会原样进入工具结果和会话记录（飞书会话也能看到），插件不另外识别密钥。

## 改代码

改代码只有一条路：新建工作区 → 修改、提交 → 推送到工作区的分支 → 开 PR/MR。之后的修改（例如评审后的追加修复）推送到同一个分支，原 PR/MR 随之更新，不再开新分支和新 PR/MR。

1. **新建。** `repo_workspace_create` 先拉取镜像，再从镜像 `git clone --shared` 出一份普通的 git 克隆（对象经 alternates 共用镜像，不另占空间），检出工作分支，并经 DSH 的 `workingDirectory` 服务把会话的工作目录切过去，仓库里的 AGENTS.md、项目 SKILL 随之生效。目录默认是当前工作目录下的 `<仓库名>/`（重名时加 `-2`、`-3`），当前工作目录不在会话目录（沙箱可写根）里时放在会话目录下，当前工作目录在某个工作区里时放在那个工作区旁边；给出的 `path` 必须在会话目录里，并且不存在或为空。`base` 默认是仓库清单里的基线分支，起点是它的最新提交，或 `commit` 给出的、在 `base` 上的提交，PR/MR 默认合回它。`branch` 是推送的分支，不给时按[分支命名](#分支命名)模板生成（默认 `dsh/<会话 id 前 8 位>`，同一会话的工作区接着用同一个分支）；远端已有这个分支时从它的最新提交开始，接着修改（这时不能再给 `commit`）；远端没有的新分支必须符合分支名规则。`branch` 不能是默认分支、`base` 或受保护分支。
2. **修改。** Agent 用普通的文件和命令工具编辑、构建、测试，git 命令照常可用：`git status`、`git diff`、`git add`、`git commit`、`git rebase`、`git fetch`、`git pull`、`git push` 都在工作区里直接运行。工作区装了 `commit-msg` 钩子，提交说明末尾自动加一行 `DSH-Session: <会话 id>`，记录是哪个 DSH 会话做的改动。工作区的 `user.name` / `user.email` 是令牌账号（或设置页的提交身份）。
3. **推送。** 两种方式效果相同：Agent 自己 `git push`，或调用 `repo_workspace_push`。后者先经 `access/authorize` 事件问过其他插件（见[授权事件](#授权事件)），再经用户审批，然后把未提交的改动（`git add --all`，`.gitignore` 生效）提交为一个提交，推送到工作区的分支；远端分支被他人更新时以 `conflict` 失败，`forceWithLease` 按工作区上次看到的远端位置覆盖。推送失败时撤销这次调用新建的提交。工具推送的提交者是令牌所属的账号（通常是公共账号），作者默认也是它，其他插件可以把作者换成提出改动的人（见[提交尾注事件](#提交尾注事件)），提交者不变，所以检查提交者的推送规则（如 GitLab 的提交者限制）照常通过。令牌账号的身份这样确定：推送前用令牌读一次主机的当前用户接口（GitHub `GET /user`，GitLab `GET /api/v4/user`），按令牌缓存；GitHub 账号没有公开邮箱时用 `<id>+<login>@users.noreply.<主机>`，GitLab 依次取提交邮箱、邮箱、公开邮箱，都没有时用 `<id>-<用户名>@users.noreply.<主机>`；读不到时用设置页的提交身份。推送结果的 `author` 给出新提交的作者。
4. **开 PR/MR。** `repo_workspace_push` 推送成功后查一次这个分支上打开中的 PR/MR，在结果的 `openMrs` 里列出；给出 `mr` 且没有打开中的 PR/MR 时创建一个（目标默认是 `base`），结果的 `createdMr` 是新建的那个。打开中的 PR/MR 自动跟踪（见[跟踪 PR/MR](#跟踪-prmr)）。查询或创建失败不影响推送结果，`mrError` 写明原因。

### 从设置页新建工作区

「仓库」标签页里权限为「可改代码」或「可合并」的仓库有「新建工作区」按钮，「工作区」标签页也可以新建：选仓库，可选基线分支（默认是仓库的基线分支，下拉列出镜像里已有的分支）和目录名（默认仓库名，重名时加编号）。推送的新分支按[分支命名](#分支命名)模板生成，`{session}` 在这里换成随机串；表单底部写明会从哪个分支拉出什么名字的分支、PR/MR 合回哪里。要接着改已有分支，在会话里让模型给 `repo_workspace_create` 传 `branch`。工作区建在「高级 → 工作区目录」下，和工具新建的一样是完整的 git 克隆，经本机 git 代理拉取和推送。建好后页面经 DSH 的 `workspaces` 服务把目录登记为 DSH 工作区，再经 `uiWorkspace` 在里面打开一个新会话；界面没有这两个服务时只提示目录位置。设置页新建的工作区不属于任何会话：代理推送时不发 `access/authorize` 事件，提交说明的 `DSH-Session` 取当时在里面运行的会话。「在此新建会话」对任何工作区都可用，包括会话里用工具建的。删除时有未提交的改动或只在本机的提交（任何本地分支上的）会再确认一次。

### 分支命名

新分支的名字由模板生成，可选再用一条正则规则约束。两者在「高级」里全局设置，仓库可以在清单里单独设置，留空时用全局的。

- **模板** 是带占位符的文本，默认 `dsh/{session}`。`{session}` 是会话 id 的前 8 个字母和数字（小写），同一会话的工作区接着用同一个分支，没有会话时（设置页新建）换成 8 位随机十六进制；`{random}` 是 8 位随机十六进制；`{date}` 是本地日期 `YYYYMMDD`。模板必须含 `{session}` 或 `{random}`，否则每个工作区都会用同一个分支；生成的名字必须是合法的分支名。
- **规则** 是 JavaScript 正则表达式（`u` 标志），不加锚点，要匹配整个名字时自己写 `^` 和 `$`，例如 `^(feat|fix)/`。留空表示不限。规则只检查远端还没有的新分支，接着修改已有分支时不检查；模型给 `repo_workspace_create` 传的 `branch` 是新分支时同样要符合规则。
- 保存时检查模板生成的名字符合规则，不符合时拒绝保存：每个占位符分别取全数字、全字母和数字字母交错的值（`{session}` 还取 `f` 以后的字母），各种组合生成的名字都要符合规则。仓库只覆盖了一项时，另一项沿用全局设置：保存仓库时按它最终生效的模板和规则检查，保存全局设置时也检查每个覆盖了规则的仓库。

### 本机 git 代理

工作区的 `origin` 仍是仓库的真实地址，git 配置里的 `url.<代理地址>.insteadOf` 把它改写到插件在 127.0.0.1 上监听的代理 `http://127.0.0.1:<端口>/w/<工作区 id>/repo.git`，令牌只在代理里：

- 每个工作区有自己的随机密钥，写在工作区 `.git/config` 的凭据助手里，只对这个代理地址生效；代理按密钥认出工作区，只放行这个工作区的仓库。工作区记录（含密钥）保存在设置文件旁边的 `workspaces.json`，权限 0600；文件内容不合法时移到 `workspaces.json.invalid-<时间>` 并记日志，从空开始，原文件留着以便找回记录。密钥只能读写这一个仓库，而且要经过下面的推送规则；Agent 读得到它，和读得到工作区文件一样。
- 拉取（`git fetch` / `pull`）先同步镜像，再由 `git http-backend` 从镜像提供，所以拉到的总是远端的最新内容。
- 推送（`git push`）先检查每条引用更新：写操作没有关闭，仓库清单权限至少是「可改代码」，只能推分支（不能推 tag），不能删除分支，不能推到默认分支（每次向远端确认当前的默认分支）和受保护分支；然后以创建工作区的会话发 `access/authorize` 事件（`action` 是 `git-push`）。通过后代理用主机令牌转发给远端，远端的拒绝原样返回；不通过时 git 看到 `dsh-repo: <原因>` 的拒绝。推送成功后同步镜像，并跟踪这个分支上打开中的 PR/MR。
- 端口默认自动选择并记在 `workspaces.json` 里，重启后沿用；在设置页改端口后代理换到新端口，并改写所有工作区的配置。新端口监听失败时代理留在原端口，保存设置时报错。「高级 → 代理状态」显示代理当前监听的端口；它和设置的端口不一致或代理没有运行时，那里有「重试」按钮，端口空出来后点它让代理重新监听。
- 代理只监听 127.0.0.1；工作区的 git 配置为代理地址关闭 `http_proxy`。

### 工作区的安全边界

- 工作区目录由 Agent 写入，dsh-repo 把它当作不可信内容。插件进程在工作区里运行 git 时加 `-c core.hooksPath=/dev/null -c core.fsmonitor=false`，组合里有 `sandbox` 服务时再经沙箱的 `workspace-write` 方式运行，所以工作区里的钩子和配置不能让插件进程执行任意命令。
- 工作区只认 `workspaces.json` 里的记录：目录不在记录里（例如 Agent 自己 `git init` 或复制的目录）时，状态、推送和删除都以 `not-found` 拒绝。删除目录即放弃这个工作区，下次列出时清理记录。
- 镜像目录不要放在 Agent 可写的目录里；工作区不能建在镜像目录里，也不能互相嵌套。

## 合并后的分支

设置页「合并后删除源分支」（`tools.deleteSourceBranch`，默认开）打开时：

- `repo_mr_create` 在 GitLab 上创建的 MR 勾选「合并后删除源分支」，之后不论在网页上还是用工具合并，GitLab 都会删除源分支。GitHub 的 PR 没有对应选项，网页合并后的分支由仓库设置「Automatically delete head branches」或下面的 `repo_branch_delete` 清理。
- `repo_mr_merge` 合并后删除源分支：GitHub 在合并成功后删除，GitLab 在合并请求里带上 `should_remove_source_branch`。来自 fork 的分支、默认分支和受保护分支不删（GitHub 的保护规则即使允许删除也不删）；GitHub 上分支在合并后又有了新提交时也不删。删除失败不影响合并结果，结果的 `sourceBranch` 写明分支名、是否删除和没删的原因；GitHub 仓库已经自动删除了这个分支时按已删除报告。

`repo_branch_delete` 不受这个开关控制，跟随写操作审批，用来清理已经留下来的分支。它只删除同时满足以下条件的分支，其余情况拒绝，所以不会丢掉没合入的工作：

- 分支的最新提交是本仓库某个已合并 PR/MR 的 head 提交，即合并之后没有再推送新提交；否则以 `conflict` 拒绝。
- 没有从它发起、仍打开中的 PR/MR；否则以 `conflict` 拒绝。
- 不是默认分支，也不是受保护分支；否则以 `forbidden` 拒绝。

GitHub 和 GitLab 的删除分支接口都不接受预期提交，所以分支的最新提交在列出 PR/MR 之后、紧挨着删除时读取；这一次读取和删除之间如果恰好有人推送，新提交仍可能随分支一起删除。

## 跟踪 PR/MR

通过工具创建或重开的 PR/MR、工作区推送（`repo_workspace_push` 或经代理的 `git push`）到的打开中的 PR/MR，以及模型用 `repo_mr_watch` 要求跟踪的 PR/MR，由插件定时检查，把 CI 结果、评论、评审和合并结果送回发起它的会话。模型不用自己轮询；工具结果里的 `watching: true` 表示已经开始跟踪。

| 动态 | 默认 | 说明 |
|---|---|---|
| CI 失败 | 唤醒 | 当前 head 的检查或流水线失败，其他检查还在运行时也立即报；之后又有检查失败（包括重跑后再次失败）时再报一次 |
| CI 通过 | 只记录 | 当前 head 的检查全部通过，包括失败后在同一个 head 上重跑通过 |
| 新评论 | 唤醒 | 对话评论、代码行评论、只有评论的评审；通过 `repo_mr_comment` / `repo_issue_comment` 发的评论不算 |
| 要求修改 | 唤醒 | GitHub 评审 `CHANGES_REQUESTED`；GitLab 系统备注「requested changes」 |
| 批准 | 只记录 | GitHub 评审 `APPROVED`；GitLab 系统备注「approved this merge request」 |
| 出现冲突 | 唤醒 | GitHub `mergeable_state` 为 `dirty`；GitLab `has_conflicts` |
| 别人推送 | 只记录 | head 变成不是经工作区推送的提交 |
| 已合并 / 已关闭 | 唤醒 | 立即送达，之后停止跟踪 |
| 长期无动态 | 唤醒 | 达到 `idleDays` 天没有动态时，告诉会话已停止跟踪，模型用一句话转告用户 |

- **检查方式。** 轮询，不用 webhook：DSH 只监听本机，注册 webhook 也需要每个项目的维护者权限。有动态、CI 运行中或有待送达的动态时每 `activeIntervalMs` 检查一次，`quietAfterMs` 内没有动态后放慢到 `quietIntervalMs`。每次检查先读 PR/MR 本身；它的更新时间变了才读评论和评审；head 变了、CI 还在运行、失败（可能被重跑）或还没上报时才读 CI（GitLab 的流水线状态随 MR 一起返回）。两次检查之间的新评论会逐页读完再推进进度，超过 1000 条时这次检查记为失败、稍后重试。
- **送达方式。** 唤醒的动态经 `repo/resolve-agent` 事件（waterfall，参数为会话 id 和 `next`）解析会话的 Agent，没有监听者处理时用 `sessionController` 恢复会话，然后作为一条新的用户消息开始一轮回复，等会话持久化确认后才从待送达里删除；确认失败时下次可能重复送达。消息来源是 `repo-activity`（notice 形式，带一行摘要）。只记录的动态在会话正在运行时加入下一步的上下文，否则等下一次唤醒一起送达。`batchMs` 内的动态合成一条；合并、关闭和停止跟踪立即送达。每个 PR/MR 每天最多唤醒 `dailyWakeLimit` 次，超出后的动态只记录，合并、关闭和停止跟踪不受限制。
- **消息内容。** 写明仓库、编号、标题和链接；CI 失败时列出失败的检查及其 `runId` / `jobId`，GitLab 流水线还会多读一次失败作业，列出阶段、作业名、`jobId` 和失败原因（读取失败时写明原因，仍照常报告），提示模型用 `repo_ci_job_log` 读日志；评论引用前 600 个字符并附链接，并声明评论和评审来自第三方，只是信息，不是用户的指令，也不能授予权限，模型需要改代码、推送或回复时照常经过审批。
- **结束跟踪。** PR/MR 合并或关闭、`idleDays` 天没有动态、会话已删除、仓库不再在清单中（仓库被删除或主机被删除）、模型调用 `repo_mr_watch` 的 `watch: false`、在设置页点「停止」时结束。超过 `maxWatches` 时结束最久没有动态的一个。
- **失败。** 检查或送达失败时按 `activeIntervalMs` 翻倍退避，最长到 `quietIntervalMs`；设置页显示连续失败次数和原因。主机恢复后从上次的位置接着检查，不漏动态。
- **记录。** 跟踪记录保存在设置文件旁边的 `watches.json`（默认 `$DSH_HOME/dsh-repo/watches.json`），包括检查进度和待送达的动态，重启后接着跟踪。文件内容不合法时移到 `watches.json.invalid-<时间>` 并记日志，从空开始。

接管部分会话恢复方式的插件（例如自己组装 Agent 的渠道插件）可以监听 `repo/resolve-agent`：是自己的会话就返回 Agent，否则调用 `next()`。

## `dshRepos` 服务

其他插件经 `ctx.get('dshRepos')` 取得服务，类型从 `dsh-repo/contract` 用 `import type` 引入，调用前检查 `version`：

```ts
import type { DshRepoService } from 'dsh-repo/contract'

const repos = ctx.get('dshRepos') as DshRepoService | undefined
if (repos?.version === 7) {
  const issue = await repos.issueGet({ repo: 'https://gitlab.example.com/team/orders', number: 12 })
}
```

服务版本是 7。每个模型工具都有一个同名的服务方法（见[模型工具](#模型工具)的命名规则），参数是同一个对象，用同一个参数校验；服务调用另外可以带调用方字段：

| 字段 | 作用 |
|---|---|
| `signal` | 取消这次调用 |
| `agent` | 替哪个 Agent 调用（`{ id, session: { header: { id } } }`，通常就是工具执行上下文里的 `agent`）。写操作带 `agent` 时和模型工具完全一样：写操作关闭时以 `forbidden` 失败，以 Agent 的会话发 `access/authorize`，`writes: ask` 时请用户审批，没批准时以 `declined` 失败；推送时发 `repo/commit-trailers`、PR/MR 自动跟踪这个会话 |
| `callId` | 审批卡片上对应的工具调用 id |

不带 `agent` 的写操作只检查写操作开关和仓库清单的权限（写操作关闭时同样以 `forbidden` 失败），不发授权事件也不审批，由调用方插件负责。`mrWatch` 必须带 `agent`。工作区方法的 `path` 必须是绝对路径，服务调用不切换会话的工作目录。

除这些方法外，服务还提供插件和设置页用的方法：`repoResolve`、`repoOnChange`、`featureRegister`、`hostList`、`hostAdd`、`hostRemove`、`hostSetToken`、`hostOnChange`、`settingsGet`、`settingsUpdate`（镜像目录、工作区默认目录、代理端口、提交身份）。完整定义见 [`src/contract.ts`](src/contract.ts)。所有预期内的失败都以 `name === 'RepoError'` 的错误拒绝，`code` 取值为 `invalid`、`not-allowed`、`unauthenticated`、`forbidden`、`not-found`、`conflict`、`rate-limited`、`too-large`、`unavailable`、`declined`。

一个功能插件的用法：

```ts
const repos = ctx.get('dshRepos') as DshRepoService | undefined
if (repos?.version === 7) {
  ctx.effect(() => repos.featureRegister({ id: 'log-analysis', title: '日志分析' }))
  ctx.effect(() => repos.repoOnChange(() => { void repos.repoList({ feature: 'log-analysis' }).then(reload) }))
  // 功能的分支：打开时选的分支，没选时是基线分支，再没有就是远端默认分支。
  const [repo] = await repos.repoList({ feature: 'log-analysis' })
  const branch = repo?.features.find(item => item.id === 'log-analysis')?.branch ?? repo?.base
  const lease = await repos.snapshotAcquire({ repo: 'https://gitlab.example.com/team/orders', ...branch === undefined ? {} : { ref: branch } })
  try {
    analyze(lease.path)
  } finally {
    lease.release()
  }
}
```

从 6 升到 7：

- `CatalogRepo.branch` 拆开：`base` 是基线分支（新工作区的起点和 PR/MR 的目标，`workspaceCreate` 不给 `base` 时取它，`snapshotAcquire` 不给 `ref` 时取它）；`features` 从功能 id 数组变成 `{ id, branch? }` 数组，`branch` 是这个功能用的分支，留空用 `base`；`localSync.branch` 是本地同步的分支，留空用 `base`；新增 `branchRules`（仓库自己的分支命名模板和规则）。
- `repoAdd` 和 `repo_add` 移除：仓库只能在设置页添加。
- `workspaceCreate` 不给 `branch` 时按分支命名模板生成；给出的新分支必须符合分支名规则，否则以 `invalid` 失败。插件需要可预期的分支名时，用返回值里的 `branch`。

从 5 升到 6：

- 方法全部改名并改成一个参数对象，例如 `getIssue(repo, n)` → `issueGet({ repo, number })`、`createMr` → `mrCreate`、`listCiRuns` → `ciList`、`ciJobLog` → `ciLog`、`addRepo` → `repoAdd`、`listRepos` → `repoList`（现在返回 Promise）、`registerFeature` → `featureRegister`、`onReposChange` → `repoOnChange`、`listHosts` / `addHost` / `removeHost` / `setHostToken` → `hostList` / `hostAdd` / `hostRemove({ url })` / `hostSetToken({ url, token })`；类型里的 `Change*` 改为 `Mr*`。
- 写操作的授权与审批跟随 `agent` 字段（以前是 `session` 字段，且不审批）。
- 镜像和工作区方法换成 `snapshotAcquire`（返回 `{ repo, commit, path, release }`）和 `workspaceCreate` / `workspaceList` / `workspaceStatus` / `workspacePush` / `workspaceRemove`；`syncMirror`、`readMirrorFile`、`listMirrorTree`、`acquireSnapshot`、`openWorkspace`、`workspaceChanges`、`pushWorkspace` 和 `setMirrorDir` 移除（镜像目录用 `settingsUpdate({ mirrorDir })`）。
- `repo/commit-trailers` 事件的 `dir` 改名为 `path`；`access/authorize` 的 `action` 是服务方法名（经代理的推送是 `git-push`）。

### 授权事件

每个写操作在参数校验通过之后、询问用户审批之前，用 `ctx.parallel('access/authorize', event)` 问其他插件这次调用的会话能不能写：模型工具总是发，服务调用带 `agent` 时发，经代理的 `git push` 以创建工作区的会话发。`event` 带 `session`（会话 id，可能是子 Agent 的会话，监听者自己顺着 `parentSession` 找到它认识的会话）、`level`（dsh-repo 的写操作发 `code-write`；`wiki-read`、`wiki-write`、`admin` 留给其他插件的写操作，监听者拒绝不认识的级别）、`action`（服务方法名，经代理的推送是 `git-push`）和 `summary`（审批卡片上的中文说明）。认识这个会话且不允许的监听者抛出带原因的 `Error`，调用以 `forbidden` 失败，不问用户、不改任何东西；不认识这个会话的监听者直接返回；没有监听者就是允许。`tools.writes` 关闭时不发事件，直接以 `forbidden` 失败；「不审批」模式仍然发。

监听者不需要依赖 dsh-repo 的包，在本地声明事件类型即可：

```ts
interface AuthorizeEvent {
  readonly session: string
  readonly level: 'code-write' | 'wiki-read' | 'wiki-write' | 'admin'
  readonly action: string
  readonly summary: string
}

ctx.on('access/authorize', (event: AuthorizeEvent) => {
  const who = whoOpened(event.session)
  if (who === undefined) return
  if (!who.may(event.level)) throw new Error(`${who.name} 没有改代码权限`)
})
```

### 提交尾注事件

`repo_workspace_push` 为某个会话提交改动之前（会话是调用的 Agent 的会话，服务调用不带 `agent` 时是创建工作区的会话），在 `access/authorize` 允许之后，用 `ctx.parallel('repo/commit-trailers', event)` 通知其他插件。`event` 带 `session`（会话 id）和 `path`（工作区目录），监听者调用 `event.add(token, value)` 追加尾注，写在 `DSH-Session:` 之后，按添加顺序排列；调用 `event.setAuthor(name, email)` 把提交作者设为别人（例如提出改动的人），提交者仍是令牌账号。GitHub 和 GitLab 按作者邮箱把提交关联到平台用户，邮箱要是对方账号已验证的邮箱才显示对方的头像和链接。监听者应在返回（或返回的 promise 结束）之前调用 `add` 和 `setAuthor`；所有监听者都结束之后再调用不生效，但某个监听者结束后、其他监听者还在运行时的调用仍会记下。规则：

- 尾注名以字母开头，只含字母、数字和 `-`，最长 64 个字符，不能是 `DSH-Session`；值是一行，1 到 200 个字符，不含控制字符。每次推送最多 20 条。不合规时推送以 `invalid` 失败。
- 作者名是一行，不含 `<` `>`；邮箱不含 `<` `>` 和空白，不合规时推送以 `invalid` 失败。一次推送中 `setAuthor` 被调用不止一次（不论来自几个监听者）时推送以 `invalid` 失败，不提交任何内容。作者按「监听者 > 设置页的提交身份 > 令牌账号」确定。
- 任何监听者抛错时推送以 `unavailable` 失败，不提交任何内容。
- 没有会话（服务调用不带 `agent`，工作区也不是会话创建的）时不发事件。Agent 自己 `git commit` 的提交不经过这个事件，只有 `commit-msg` 钩子加的 `DSH-Session:`。

监听者不需要依赖 dsh-repo 的包，在本地声明事件类型即可：

```ts
interface CommitTrailersEvent {
  readonly session: string
  readonly path: string
  add(token: string, value: string): void
  setAuthor(name: string, email: string): void
}

ctx.on('repo/commit-trailers', (event: CommitTrailersEvent) => {
  event.add('Feishu-User', '张三 <u_123>')
  event.setAuthor('张三', 'zhangsan@example.com')
})
```

## 本地镜像

镜像是仓库的裸克隆（`git clone --bare`），拉取所有分支和 tag，关闭自动 gc，`HEAD` 每次同步时跟随远端默认分支。快照（`repo_snapshot_acquire` / `snapshotAcquire`）是某个提交的只读文件目录，用镜像的对象展开，不带 `.git`；同一提交的持有者共用一份，全部 `release()` 后删除。工作区从镜像克隆、拉取经镜像提供，见[改代码](#改代码)。

- 镜像目录没有默认值，必须在「代码仓库」设置页的「高级」里手动输入或用系统目录选择框（本机 GUI 会话可用）设置，也可以由其他插件调用 `settingsUpdate({ mirrorDir })`。未设置时，拉取镜像、创建快照、创建工作区、统计占用和本地同步都以 `unavailable` 拒绝，错误说明去哪里设置；设置页显示红色提示。所选目录保存在设置文件（默认 `$DSH_HOME/dsh-repo/hosts.json`）的 `mirrorDir` 字段，不写 cordis.yml；「清除」删除该字段。目录不存在时创建，无法创建或写入时拒绝。换目录后旧目录里的镜像不搬也不删，之后的同步在新目录重新克隆；已经持有的快照留在旧目录直到释放。每次设置或清除都经 `hostOnChange` 通知（`kind: 'mirror'`，清除时 `dir` 为 `undefined`）。
- 镜像目录不能是 `$DSH_HOME`、系统临时目录或 `/tmp`，也不能在它们下面（按解析符号链接后的真实路径比较）：`$DSH_HOME` 存放凭据与设置且 Agent 可读，Linux 沙箱会把 `/tmp` 换成空目录。设置时违反规则的目录以 `invalid` 拒绝；设置文件里已有的目录违反规则时插件照常加载，但镜像操作停用，设置页显示原因，重新设置或清除即可。也不要把镜像目录放在 Agent 可写的目录（例如会话工作区）里。
- 镜像位于 `<镜像目录>/<主机>/<路径>.git`；快照位于 `<镜像目录>/.snapshots/` 下对应位置。新地址先克隆到临时目录再改名；同一镜像的 clone/fetch 依次执行。进程内第一次同步某个镜像时清理上次运行遗留的快照。旧版本留下的非裸镜像目录（`<主机>/<路径>`，不带 `.git`）和本地仓库的镜像（`<镜像目录>/local/`）不再使用，也不删除，确认不需要后可以手动删掉。
- 地址只接受 HTTPS URL；本机路径、`file:` URL、SSH 地址、`user@host:path`、`git://` 和 `http://` 以 `invalid` 拒绝，请改用仓库的 HTTPS 地址。地址必须在[仓库清单](#仓库清单)里：拉取和快照要求「只读」，推送要求「可改代码」。主机上的仓库自动使用该主机的令牌（GitLab 用户名 `oauth2`，GitHub 用户名 `x-access-token`），令牌经只对这次 git 进程生效的凭据助手传入，不出现在命令行、`.git/config` 或输出里，Agent 也拿不到。
- 需要本机安装 `git`；git 不会弹出交互式提示。

## 本地同步

本地同步把仓库分支的最新提交定时展开到本机任意目录，适合让 DSH 或其他工具直接读一份始终最新的文件，例如把公用 SKILL 仓库同步到一个目录，再把该目录加进 deepseek-harness `@deepseek-ai/dsh-skill-filesystem` 的 `customSkillDirs`。

- 本地同步是仓库清单里每个仓库的一项设置：打开开关，填本地目录（绝对路径，`~` 展开为主目录，不能是根目录或主目录）和同步间隔（5 分钟到 30 天，默认 12 小时）。分支是本地同步自己的分支，留空用这个仓库的基线分支，都没填时跟随远端默认分支。每个仓库最多一个本地目录；打开的本地目录不能互相包含，也不能与镜像目录重叠，比较时会解析路径中已存在部分的符号链接。关掉开关时目录和间隔保留。
- 同步先拉取镜像，再用 `git --git-dir=<镜像> --work-tree=<本地目录> read-tree --reset -u <提交>` 展开，使用每个本地目录自己的索引文件（在 `$DSH_HOME/dsh-repo/syncs/` 下），不改动镜像的 `HEAD` 和索引。本地目录里只有普通文件，没有 `.git`；git 对象只在镜像目录里存一份。
- 每次同步只写入有变化的文件，删除分支上已删除的文件，本地改过或删掉的文件恢复成仓库里的版本；分支上从来没有的文件保留。改公用仓库请走[改代码](#改代码)的工作区流程，合入后等下一次同步或点「立即同步」。
- 第一次同步要求本地目录不存在或为空，避免覆盖已有文件；目录不为空时这次同步失败并在列表里显示原因。检查通过后先在 `local-syncs.json` 记下这个目录再写文件，所以第一次同步写到一半被打断时，重试会接着写入该目录。每个本地目录有自己的索引文件（`syncs/<id>-<目录哈希>.index`）。把同步改到另一个目录时同样要求新目录为空，旧目录里的文件保留。
- 关掉本地同步时停止同步，进度保留，重新打开后在同一目录接着同步；从清单删除仓库时删除它的进度和索引，目录里的文件保留。
- 本地同步依次执行。上次成功后过了同步间隔就再同步一次；失败后在同步间隔和 30 分钟中较短的时间后重试。打开本地同步、修改地址、分支或目录和「立即同步」都会马上同步，设置页在同步结束后刷新；只改间隔时不同步，只重新计时。每个仓库的上次成功结果保存在 `$DSH_HOME/dsh-repo/local-syncs.json`（与设置文件同目录），重启后按上次成功时间继续计时，过期的同步启动后马上执行。
- 从旧版本升级：以前「本地同步」标签页的 `syncs.json` 不再读取，也不会转换；请在仓库清单里为对应仓库打开本地同步并填入原来的目录。原来的目录里已有文件，第一次同步会因目录不为空而失败，先清空目录（或换一个新目录）再同步。

## GitHub 与 GitLab 的差异处理

| 差异 | 处理 |
|---|---|
| 仓库路径 | GitHub 固定 `owner/name`；GitLab 允许多级子组 |
| 编号 | 统一为网页上的编号：GitHub number、GitLab IID |
| PR/MR 状态 | 统一为 `open` / `closed` / `merged`；GitHub 的 merged 由 `merged_at` 判断 |
| 草稿 | GitHub 用 `draft` 字段；GitLab 创建时加 `Draft: ` 标题前缀 |
| 指派人 | 统一用用户名；GitLab 先查用户 id |
| CI 状态 | GitHub 合并 check runs 与 commit statuses；GitLab 读 MR 的 head pipeline |
| CI 运行与作业 | GitLab 流水线、作业和触发作业；GitHub Actions workflow run 和作业。状态统一为 `pending` / `running` / `success` / `failure` / `canceled` / `skipped` / `manual`，`status` 保留平台原值 |
| CI 失败信息 | GitLab 读测试报告；GitHub 读失败作业的错误注解 |
| 合并方式 | GitHub 支持 merge / squash / rebase；GitLab 支持 merge / squash |
| 合并后删除源分支 | GitLab 创建 MR 时勾选 `remove_source_branch`、合并时带 `should_remove_source_branch`；GitHub 没有逐个 PR 的选项，合并成功后删除 `heads/<分支>` |

## 已知限制

- GitBeaker 不接受逐次调用的取消信号，GitLab 请求只受 `timeoutMs` 约束；调用被取消后，已发出的请求可能仍会完成。
- 修改 PR/MR 时不能切换草稿状态；GitHub 的行内评审评论、评审（approve / request changes）不在第一版范围内。
- 工作区不支持 Git LFS：代理不转发 LFS 接口，插件推送时也不上传 LFS 对象，改动 LFS 文件的推送只会带上指针文件。使用 LFS 的仓库请在工作区之外推送 LFS 文件。
- 代理分辨不出 `git push --force` 和 `--force-with-lease`，两者都按普通推送规则放行（仍不能推默认分支和受保护分支）；要保护的分支请在主机上设为受保护分支。
- 代理用 Node 内置的 `fetch` 转发推送，和两个 SDK 一样需要 `NODE_USE_ENV_PROXY=1` 才走 `HTTPS_PROXY`。
- 推送规则只在 dsh-repo 一侧检查：工作区之外的 git 客户端用自己的凭据推送不受影响。
- 不提供删除分支、删除仓库、修改仓库设置等操作。
- CI 工具不能新建流水线、运行手动作业或触发 `workflow_dispatch`，也不读取制品（artifacts）。
- 本地同步展开整个仓库，不能只同步某个子目录；子模块只建出空目录，不拉取子模块内容。

## 开发

```bash
pnpm install
pnpm check    # 类型检查、测试、构建、Host 与 client 加载校验
```

Host 端打包成 `lib/index.js`：ESM 依赖 `@octokit/rest`、`zod` 保持外部引用；GitBeaker 及其 CommonJS 依赖（`picomatch-browser`、`qs` 等）打进包内，`@gitbeaker/rest` 因此只是 devDependency。原因是插件升级后 DSH 热替换会重新导入改动过的模块，而 Node 对重新导入的 CommonJS 转导出链给出空导出，GitLab 请求会报 `isGlobMatch is not a function`；Host 加载校验要求导入 `lib/index.js` 时不加载任何 CommonJS 模块。

`src/client` 是浏览器端代码，单独用 `tsconfig.client.json` 检查，打包成 `lib/client.js` 经 DSH 的 `__ModuleLoader__` 加载，react 来自 Web 外壳的模块表。

测试用替换全局 `fetch` 的方式驱动真实的 Octokit 和 GitBeaker，不访问网络。需要真实 git 的测试把仓库放在临时目录，经 `https://git.test` 这个测试主机访问：git 的 `url.<地址>.insteadOf` 把它改写到 `file://`，或改写到本机上由 `git http-backend` 提供的 HTTP 服务，代理把推送转发到远端的路径也由后者覆盖。

包只导出 Cordis 插件入口（`name`、`inject`、`Config`、`apply`）和 `dsh-repo/contract` 里的类型；其他插件只经 `dshRepos` 服务调用 dsh-repo。Host 加载校验检查导出列表。

## 发布

版本号由 semantic-release 按 Conventional Commits 计算，并始终保持 0.x：破坏性变更只升次版本号，不会升到 1.0.0。推送（含合并 PR）到 `main` 后，检查通过就自动发布正式版；beta **只在手动触发时发布**，推送到 `dev` 只跑检查。只有 `feat`、`fix` 或破坏性变更会产生新版本。PR 标题需符合 `<type>(<scope>): <summary>`，type 取 `feat | fix | docs | test | refactor | chore | ci`。

| 分支 | 触发 | 版本 | npm dist-tag |
| --- | --- | --- | --- |
| `main` | 推送自动 | 正式版，如 `0.1.0` | `latest` |
| `dev` | 手动 | 预发布版，如 `0.1.0-beta.1` | `beta` |

发布正式版：提 `dev` → `main` 的 PR 并合并，或者直接把 `dev` 推送到 `main`（`git push origin dev:main`，只能快进，且需分支保护允许）。`main` 收到推送后 `pipeline` 先跑检查，通过后发布 npm 包、打 tag 并创建 GitHub Release。发布成功后 workflow 把这个提交带回 `dev`：`dev` 在此之后没有新提交时直接快进，有新提交时在 `dev` 上建一个合并提交（`chore: merge main into dev after stable release`）。这样正式版的 tag 总在 `dev` 的历史里，下一个 beta 从新版本往上算，发版后不用手动把 `main` 合回 `dev`。合并有冲突或被分支保护拒绝时这一步报错，此时手动提 `main` → `dev` 的 PR 合并即可。发布失败时可以在 `main` 上手动触发 `pipeline` 重试。

发布 beta：在 GitHub Actions 的 `pipeline` workflow 点击 **Run workflow** 并选择 `dev`，发布 `dev` 当前提交的 beta 版。勾选 `dry_run` 只预览下一个版本号，不发布。安装 beta 版用 `dsh-repo@beta`。
