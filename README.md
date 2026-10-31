# dsh-repo

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的代码仓库插件。它用 GitHub 官方 SDK [Octokit](https://github.com/octokit/rest.js) 和 GitLab 文档推荐的 [GitBeaker](https://github.com/jdalrymple/gitbeaker) 抹平 GitHub 与 GitLab 的差异，对其他插件提供 `dshRepos` 服务，对模型提供代码、issue、PR/MR 工具；需要本地代码目录的插件可以用它维护仓库的本地镜像、按提交的只读快照，以及用来改代码的可写工作区。

支持的主机：github.com、GitHub Enterprise Server、gitlab.com、自建 GitLab（包括部署在子路径下的实例）。

## 项目状态

测试版：提供统一接口、模型工具、运行时主机管理、本地镜像、可写工作区和 Web 设置页。接口仍可能调整。

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
      maxFileBytes: 1048576             # 读文件的上限
      maxDiffBytes: 524288              # PR/MR 与工作区 diff 的上限，超出截断
      maxTreeEntries: 1000              # 目录列表的上限，超出截断
      maxComments: 50                   # 读取 issue / PR/MR 时附带的评论条数
    mirror:
      gitTimeoutMs: 600000              # 单条 git 命令（clone、fetch、worktree、push）的超时
      otherHosts: true                  # false = 只镜像 hosts 中主机上的仓库；其他主机上的仓库只能拉取，不能推送
    hostsFile: ~/.dsh/dsh-repo/hosts.json  # 运行时添加的主机，默认 $DSH_HOME/dsh-repo/hosts.json
    tools:
      enabled: true                     # false = 只提供 dshRepos 服务，不注册模型工具
      writes: ask                       # ask：每次写操作请用户审批；allow：不审批；off：不注册写工具
      merge: false                      # true 才注册合并工具（仍按 writes 审批）
      signature: ''                     # 非空时追加到模型写的 issue、PR/MR 正文和评论末尾
```

配置在加载时校验，不合法时插件加载失败；`hostsFile` 存在但无法读取或内容不合法时同样加载失败。没有任何主机时模型看不到代码仓库工具，添加主机后立即提供。

### 运行时添加主机

除了 cordis.yml 里的 `hosts`，还可以在运行时添加主机：Web 组合中打开左侧栏「插件」，进入 dsh-repo 的详情页即可添加、删除主机和保存、清除令牌，改动立即生效；其他插件也可以调用 `addHost` 添加主机、`removeHost` 删除、`setHostToken` 保存或清除令牌。添加的主机保存在 `hostsFile`，令牌存入 DSH 凭据库，引用名由地址生成（`DSH_REPO_HOST_<哈希>`）。cordis.yml 中的主机只能改令牌，不能在运行时删除；`listHosts` 列出所有主机及令牌是否已设置，不返回令牌值。`onHostsChange` 在每次主机、令牌或镜像目录变更成功后通知监听者，例如需要在令牌更新后重新拉取镜像的插件。

设置页的数据来自宿主 `webServer` 上的 `/dsh-repo/state`、`/dsh-repo/hosts`、`/dsh-repo/host-token` 路由，请求经宿主 `connection` 做与 DSH `/api` 相同的来源校验和登录鉴权，写操作另外要求同源。没有 Web 的组合不挂载这些路由。

### 令牌

令牌每次请求时经 `ctx.credentials` 读取（环境变量 > `$DSH_HOME/.credentials.yaml` > `.env`），更换令牌不用重启。GitHub 需要 `repo`（或细粒度令牌的 Contents、Issues、Pull requests 读写）权限；GitLab 需要 `api` 权限，只读使用可以用 `read_api`。令牌只出现在发往该主机的请求头和 git 进程的凭据助手里，不进入模型上下文。推送工作区用的也是这个令牌（GitLab 的 `api` 权限包含推送）。

与 DSH 中的模型 API Key 一样，Agent 的命令以同一系统用户运行，文件权限不能把令牌与 Agent 隔离；建议使用权限最小、设置了过期时间的令牌，并用 `repos` 限定范围。

### 网络代理

两个 SDK 都使用 Node 内置的 `fetch`，它默认不读取 `HTTPS_PROXY`。需要经代理访问时，用支持 `NODE_USE_ENV_PROXY=1` 的 Node 版本启动 dsh。

## 模型工具

所有工具的 `repo` 参数接受仓库网址、git 地址或 `主机/路径`；PR/MR 页面的网址也可以直接粘贴。编号是网页上显示的编号（GitLab 的 IID）。工作区按仓库的 HTTPS 地址检出，所以 `repo` 写成 SSH 地址也可以。

| 工具 | 作用 | 审批 |
|---|---|---|
| `repo_info` | 默认分支、可见性、描述、克隆地址 | 否 |
| `repo_list_branches` / `repo_list_commits` | 分支、提交历史 | 否 |
| `repo_list_tree` / `repo_read_file` | 目录与文件内容 | 否 |
| `repo_issue_list` / `repo_issue_get` | issue 列表、单个 issue 及评论 | 否 |
| `repo_mr_list` / `repo_mr_get` / `repo_mr_diff` / `repo_mr_status` | PR/MR 列表、详情与评论、diff、CI 与可合并状态 | 否 |
| `repo_workspace_open` | 在当前工作目录下检出可写工作区，并把会话的工作目录切到那里，见[改代码](#改代码) | 否 |
| `repo_workspace_changes` | 工作区相对起点提交的改动：文件与增删行数、已推送的提交、diff | 否 |
| `repo_workspace_push` | 提交工作区未提交的改动并推送到新分支，从不强推 | 是 |
| `repo_issue_create` / `repo_issue_update` / `repo_issue_comment` | 创建、修改、关闭或重开、评论 issue | 是 |
| `repo_mr_create` / `repo_mr_update` / `repo_mr_comment` | 创建（可为草稿）、修改、关闭或重开、评论 PR/MR | 是 |
| `repo_mr_merge` | 按 `headSha` 合并，head 已变化时拒绝；默认不注册 | 是 |

- 写操作在 `writes: ask` 下每次调用都经 `ctx.approval` 请用户确认一次，被拒绝时工具返回 `{ "status": "declined" }`，不会调用主机。组合里没有审批服务时写工具报错。
- `repo_workspace_push` 的审批提示列出仓库、目标分支、起点、改动文件与增删行数和提交说明。
- 失败时工具报错，消息以失败类型开头，例如 `[not-found]`、`[forbidden]`、`[conflict]`。

## 改代码

改代码只有一条路：检出工作区 → 修改 → 推送到新分支 → 开 PR/MR。

1. **检出。** `repo_workspace_open` 先拉取镜像，再以 `baseBranch`（默认是默认分支）的最新提交或给定的 `commit` 为起点，在当前工作目录下新建 `<仓库名>/`（重名时加 `-2`、`-3`），并经 DSH 的 `workingDirectory` 服务把会话的工作目录切过去，仓库里的 AGENTS.md、项目 SKILL 随之生效。当前工作目录不在会话的项目目录（沙箱可写根）内时，工作区放在项目目录下；当前目录在另一个工作区里时，放在那个工作区旁边。
2. **修改。** Agent 用普通的文件和命令工具编辑、构建、测试。工作区的 git 元数据（索引、HEAD、本地分支和提交）留在镜像里，Agent 只能改文件，`git status`、`git diff`、`git log` 这类只读命令可以用，`git add`、`git commit`、`git checkout` 会因为写不了元数据而失败。
3. **推送。** `repo_workspace_push` 经用户审批后，由插件进程把未提交的改动（`git add --all`，`.gitignore` 生效）提交为一个提交，再把工作区推送到远端分支。第一次推送要给出分支名：不能是起点分支或远端默认分支，远端已有同名分支时以 `conflict` 失败，推送用 `--force-with-lease=<分支>:` 保证只创建、不覆盖；之后的推送只能去同一个分支，普通推送，远端被他人更新时以 `conflict` 失败。推送失败时撤销这次调用新建的提交。推送用该主机的令牌，主机没有配置时报 `unauthenticated`；提交作者和提交者是本机的 git 身份（服务调用可以用 `author` 指定）。
4. **开 PR/MR。** 用 `repo_mr_create`，`sourceBranch` 是推送的分支，`targetBranch` 是起点分支。

工作区目录归调用方所有，dsh-repo 不删除它；删除目录即放弃这个工作区，进程下次启动后第一次同步该镜像时清理它在镜像里的本地分支。换了镜像目录后，旧目录里镜像的工作区不能再推送。

工作区目录由 Agent 写入，dsh-repo 把它当作不可信内容：每次操作前核对工作区的 `.git` 文件与镜像里的记录互相指向、且元数据属于 dsh-repo 的镜像目录，再显式指定 `--git-dir` 和 `--work-tree` 运行 git，所以伪造的 `.git` 不能让插件进程在 Agent 控制的仓库配置下运行 git。镜像目录不要放在 Agent 可写的目录里。

## `dshRepos` 服务

其他插件经 `ctx.get('dshRepos')` 取得服务，类型从 `dsh-repo/contract` 用 `import type` 引入，调用前检查 `version`：

```ts
import type { DshRepoService } from 'dsh-repo/contract'

const repos = ctx.get('dshRepos') as DshRepoService | undefined
if (repos?.version === 1) {
  const issue = await repos.getIssue('https://gitlab.example.com/team/orders', 12)
}
```

接口覆盖仓库信息、分支、提交、目录、文件、issue 与 PR/MR 的读写和合并，以及主机管理、本地镜像和可写工作区，完整定义见 [`src/contract.ts`](src/contract.ts)。服务版本是 2。`openWorkspace(url, { dir, baseBranch, commit })` 在调用方给的目录（必须不存在）检出工作区，`workspaceChanges(dir)` 返回改动，`pushWorkspace(dir, { branch, message, author })` 提交并推送，规则见[改代码](#改代码)；调用方先用 `workspaceChanges` 检查改动范围再推送。`getBranch` 读取单个分支，分支不存在时返回 `undefined`。所有预期内的失败都以 `name === 'RepoError'` 的错误拒绝，`code` 取值为 `invalid`、`not-allowed`、`unauthenticated`、`forbidden`、`not-found`、`conflict`、`rate-limited`、`too-large`、`unavailable`。

## 本地镜像

`syncMirror(url, { branch })` 把仓库拉取为只拉取、不检出的镜像，返回分支最新提交；`readMirrorFile`、`listMirrorTree` 直接从提交的 git 对象读文件和目录；`acquireSnapshot(url, commit)` 返回该提交的只读检出（`git worktree`），同一提交的持有者共用一份，全部 `release()` 且不再是最近一次同步的提交时删除。

- 镜像目录默认是 `$DSH_HOME/dsh-repo/mirrors`，可以在「插件 → dsh-repo」页面手动输入或用系统目录选择框（本机 GUI 会话可用）换到别处，也可以由其他插件调用 `setMirrorDir`。所选目录与运行时添加的主机一起保存在 `hostsFile`（默认 `$DSH_HOME/dsh-repo/hosts.json`）的 `mirrorDir` 字段，不写 cordis.yml；恢复默认时删除该字段。目录不存在时创建，无法创建或写入时拒绝。换目录后旧目录里的镜像不搬也不删，之后的同步在新目录重新克隆；已经持有的快照留在旧目录直到释放。每次换目录都经 `onHostsChange` 通知（`kind: 'mirror'`）。
- 镜像和主机文件都在 DSH 主目录下，不在插件的安装目录里，升级、卸载或重装插件不会删除它们。
- 镜像位于 `<镜像目录>/<主机>/<路径>`，本地路径位于 `<镜像目录>/local/`；快照位于 `<镜像目录>/.snapshots/` 下对应位置。新地址先克隆到临时目录再改名；同一镜像的 clone/fetch 依次执行。进程内第一次同步某个镜像时清理上次运行遗留的快照。
- 地址只接受 HTTPS URL、`file:` URL 或绝对路径；SSH 地址、`user@host:path`、`git://` 和 `http://` 以 `invalid` 拒绝，请改用仓库的 HTTPS 地址。属于已配置主机的地址受 `repos` 范围限制，并自动使用该主机的令牌（GitLab 用户名 `oauth2`，GitHub 用户名 `x-access-token`），令牌经只对这次 git 进程生效的凭据助手传入，不出现在命令行、`.git/config` 或输出里，Agent 也拿不到。其他主机上的仓库不带凭据拉取（适合公开仓库），`mirror.otherHosts: false` 时拒绝；本地路径不需要凭据。
- 需要本机安装 `git`；git 不会弹出交互式提示。

## GitHub 与 GitLab 的差异处理

| 差异 | 处理 |
|---|---|
| 仓库路径 | GitHub 固定 `owner/name`；GitLab 允许多级子组 |
| 编号 | 统一为网页上的编号：GitHub number、GitLab IID |
| PR/MR 状态 | 统一为 `open` / `closed` / `merged`；GitHub 的 merged 由 `merged_at` 判断 |
| 草稿 | GitHub 用 `draft` 字段；GitLab 创建时加 `Draft: ` 标题前缀 |
| 指派人 | 统一用用户名；GitLab 先查用户 id |
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
