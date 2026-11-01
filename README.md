# dsh-repo

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的代码仓库插件。它用 GitHub 官方 SDK [Octokit](https://github.com/octokit/rest.js) 和 GitLab 文档推荐的 [GitBeaker](https://github.com/jdalrymple/gitbeaker) 抹平 GitHub 与 GitLab 的差异，对其他插件提供 `dshRepos` 服务，对模型提供代码、issue、PR/MR 工具；需要本地代码目录的插件可以用它维护仓库的本地镜像、按提交的只读快照，以及用来改代码的可写工作区。

支持的主机：github.com、GitHub Enterprise Server、gitlab.com、自建 GitLab（包括部署在子路径下的实例）。

## 项目状态

测试版：提供统一接口、模型工具、运行时主机管理、本地镜像、可写工作区和左侧栏「代码仓库」设置页。接口仍可能调整。

## 安装

```bash
# 在 deepseek-harness 仓库内
pnpm build   # 本地 checkout 需要先构建
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh-repo
```

包内的 `cordis.patch.yml` 把 `dsh-repo` 加入 profile 的 bundle 列表，Loader 行的稳定 id 是 `dsh-repo`。插件需要宿主提供 `tools` 和 `credentials` 服务；写操作审批使用 `approval` 服务（`@deepseek-ai/dsh-user-approval`），dsh-channels 会把审批渲染成飞书卡片。

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

cordis.yml 在加载时校验，写入其他键（例如以前的 `repos`、`limits`、`tools`、`mirror`、`timeoutMs`）时插件加载失败；设置文件存在但无法读取或内容不合法时同样加载失败。

### 设置页

| 标签页 | 设置 | 默认 | 保存方式 |
|---|---|---|---|
| 主机 | 添加（类型、地址、GitHub 接口地址、别名、令牌）、删除主机，保存或清除令牌 | 无 | 立即 |
| 高级 | 镜像目录 | `$DSH_HOME/dsh-repo/mirrors` | 立即 |
| 访问范围 | `repos`：可访问的仓库，`主机/路径`，末段 `*` 匹配一层、`**` 匹配任意多层；空 = 主机上令牌能访问的全部仓库 | 空 | 保存条 |
| 访问范围 | `mirror.otherHosts`：是否允许不带凭据镜像不在主机列表中的仓库 | 允许 | 保存条 |
| 模型工具 | `tools.enabled`：是否提供 `repo_*` 工具 | 提供 | 保存条 |
| 模型工具 | `tools.writes`：`ask` 每次审批、`allow` 不审批、`off` 不提供写工具 | `ask` | 保存条 |
| 模型工具 | `tools.merge`：是否提供合并工具（审批跟随 `writes`） | 不提供 | 保存条 |
| 模型工具 | `tools.deleteSourceBranch`：合并后删除源分支，见[合并后的分支](#合并后的分支) | 删除 | 保存条 |
| 模型工具 | `tools.signature`：追加到模型写的正文和评论末尾 | 空 | 保存条 |
| 高级 | `timeoutMs`：一次接口调用 | 30 秒 | 保存条 |
| 高级 | `mirror.gitTimeoutMs`：一条 git 命令（clone、fetch、worktree、push） | 600 秒 | 保存条 |
| 高级 | `limits.perPage` / `maxPerPage` / `maxComments` / `maxTreeEntries` | 30 / 100 / 50 / 1000 | 保存条 |
| 高级 | `limits.maxFileBytes` / `maxDiffBytes`：读文件上限、diff 截断 | 1 MiB / 512 KiB | 保存条 |

「立即」的改动点击即保存；其余设置改动后页面底部出现保存条，每项改过时旁边有「恢复默认」。保存后的设置从下一次调用开始生效，不用重启：工具在模型的下一步按新设置提供或隐藏，已经提供的写工具在写操作被关闭后拒绝执行。设置文件的 `settings` 字段只记录与默认不同的项，「全部恢复默认」删除该字段；以后版本调整默认值时，没改过的项随之变化。「插件 → dsh-repo」页面只保留一个指向该入口的「打开设置」按钮。

没有任何主机时模型看不到代码仓库工具，添加主机后立即提供。

### 运行时添加主机

除了 cordis.yml 里的 `hosts`，还可以在设置页添加、删除主机和保存、清除令牌，改动立即生效；其他插件也可以调用 `addHost` 添加主机、`removeHost` 删除、`setHostToken` 保存或清除令牌。添加的主机保存在设置文件，令牌存入 DSH 凭据库，引用名由地址生成（`DSH_REPO_HOST_<哈希>`）。cordis.yml 中的主机只能改令牌，不能在运行时删除；`listHosts` 列出所有主机及令牌是否已设置，不返回令牌值。`onHostsChange` 在每次主机、令牌或镜像目录变更成功后通知监听者，例如需要在令牌更新后重新拉取镜像的插件。

设置页的数据来自宿主 `webServer` 上的 `/dsh-repo/state`、`/dsh-repo/hosts`、`/dsh-repo/host-token`、`/dsh-repo/mirror`、`/dsh-repo/settings` 路由，请求经宿主 `connection` 做与 DSH `/api` 相同的来源校验和登录鉴权，写操作另外要求同源。没有 Web 的组合不挂载这些路由。

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
| `repo_workspace_push` | 提交工作区未提交的改动并推送到工作区的远端分支，从不强推；结果列出这个分支上打开中的 PR/MR | 是 |
| `repo_issue_create` / `repo_issue_update` / `repo_issue_comment` | 创建、修改、关闭或重开、评论 issue | 是 |
| `repo_mr_create` / `repo_mr_update` / `repo_mr_comment` | 创建（可为草稿）、修改、关闭或重开、评论 PR/MR | 是 |
| `repo_mr_merge` | 按 `headSha` 合并，head 已变化时拒绝；按设置一并删除源分支；默认不提供 | 是 |
| `repo_branch_delete` | 删除已经合并的遗留分支，见[合并后的分支](#合并后的分支) | 是 |

- 写操作在设置页选「每次审批」（`writes: ask`）时每次调用都经 `ctx.approval` 请用户确认一次，被拒绝时工具返回 `{ "status": "declined" }`，不会调用主机。组合里没有审批服务时写工具报错。
- 审批提示首行写要做的事，之后每行一项「标签：值」，文件列表缩进两格；审批端按行展示即可。`repo_workspace_push` 列出目标分支、仓库、起点、提交说明首行、改动总数与增删行数，以及按改动量排序的前 12 项文件改动，整个目录的移动合并成一行。
- 失败时工具报错，消息以失败类型开头，例如 `[not-found]`、`[forbidden]`、`[conflict]`。

## 改代码

改代码只有一条路：检出工作区 → 修改 → 推送到新分支 → 开 PR/MR。之后的修改（例如评审后的追加修复）推送到同一个分支，原 PR/MR 随之更新，不再开新分支和新 PR/MR。

1. **检出。** `repo_workspace_open` 先拉取镜像，再以 `baseBranch`（默认是默认分支）的最新提交或给定的 `commit` 为起点，在当前工作目录下新建 `<仓库名>/`（重名时加 `-2`、`-3`），并经 DSH 的 `workingDirectory` 服务把会话的工作目录切过去，仓库里的 AGENTS.md、项目 SKILL 随之生效。当前工作目录不在会话的项目目录（沙箱可写根）内时，工作区放在项目目录下；当前目录在另一个工作区里时，放在那个工作区旁边。给出 `branch` 时接着这个已有的远端分支修改：以它的最新提交为起点，工作区从一开始就记下这个分支，之后每次推送都是追加到它的普通推送；`baseBranch` 这时只是合入目标。`branch` 不能是 `baseBranch` 或远端默认分支，也不能和 `commit` 同时给出。当前工作区就是这个仓库、已经推送到这个分支、并且（给出 `baseBranch` 时）合入目标相同时，工具直接复用它，不新开目录。工具给出 `baseBranch` 而它是某个打开中的 PR/MR 的源分支时，以 `invalid` 拒绝，并提示在原工作区继续修改或改用 `branch`，避免出现「在修复分支上再开分支、再提一个合入修复分支的 PR/MR」。
2. **修改。** Agent 用普通的文件和命令工具编辑、构建、测试。工作区的 git 元数据（索引、HEAD、本地分支和提交）留在镜像里，Agent 只能改文件，`git status`、`git diff`、`git log` 这类只读命令可以用，`git add`、`git commit`、`git checkout` 会因为写不了元数据而失败。
3. **推送。** `repo_workspace_push` 经用户审批后，由插件进程把未提交的改动（`git add --all`，`.gitignore` 生效）提交为一个提交，再把工作区推送到远端分支。新工作的第一次推送要给出分支名：不能是起点分支或远端默认分支，远端已有同名分支时以 `conflict` 失败，推送用 `--force-with-lease=<分支>:` 保证只创建、不覆盖；之后的推送，以及接着已有分支打开的工作区的每次推送，只能去同一个分支（不必再给分支名），普通推送，远端被他人更新时以 `conflict` 失败。推送失败时撤销这次调用新建的提交。推送跳过 git 钩子；本机装了 Git LFS 且新提交改动了 LFS 文件时，先用 `git lfs push` 上传 LFS 对象，再推送分支。检出工作区时同样带上主机令牌，供 Git LFS 下载文件。推送用该主机的令牌，主机没有配置时报 `unauthenticated`。提交作者和提交者默认是令牌所属的账号（通常是公共账号）：推送前用令牌读一次主机的当前用户接口（GitHub `GET /user`，GitLab `GET /api/v4/user`），按令牌缓存；GitHub 账号没有公开邮箱时用 `<id>+<login>@users.noreply.<主机>`，GitLab 依次取提交邮箱、邮箱、公开邮箱，都没有时用 `<id>-<用户名>@users.noreply.<主机>`。令牌读不到自己的账号时推送以 `forbidden` 或 `unauthenticated` 失败（GitLab 令牌需要 `read_user` 或 `api` 权限）。服务调用可以用 `author` 指定身份；本地路径的仓库用本机的 git 身份。提交说明末尾自动加一行 `DSH-Session: <会话 id>`，记录是哪个 DSH 会话做的改动，可在 DSH 中按 id 找回对话。其他插件可以通过 `repo/commit-trailers` 事件在这一行后面追加尾注（例如飞书渠道追加 `Feishu-User: 名字 <user_id>`），见下文「提交尾注事件」。
4. **开 PR/MR。** `repo_workspace_push` 推送成功后查一次这个分支上打开中的 PR/MR，在结果的 `openChanges` 里列出，并在 `next` 里提示模型：已有时它已包含这次推送，不要再创建；没有时用 `repo_mr_create` 创建，`sourceBranch` 是推送的分支，`targetBranch` 是起点分支。查询失败不影响推送结果，`next` 里写明原因并提示先用 `repo_mr_list` 确认。

工作区目录归调用方所有，dsh-repo 不删除它；删除目录即放弃这个工作区，进程下次启动后第一次同步该镜像时清理它在镜像里的本地分支。换了镜像目录后，旧目录里镜像的工作区不能再推送。

工作区目录由 Agent 写入，dsh-repo 把它当作不可信内容：每次操作前核对工作区的 `.git` 文件与镜像里的记录互相指向、且元数据属于 dsh-repo 的镜像目录，再显式指定 `--git-dir` 和 `--work-tree` 运行 git，所以伪造的 `.git` 不能让插件进程在 Agent 控制的仓库配置下运行 git。镜像目录不要放在 Agent 可写的目录里。

## 合并后的分支

设置页「合并后删除源分支」（`tools.deleteSourceBranch`，默认开）打开时：

- `repo_mr_create` 在 GitLab 上创建的 MR 勾选「合并后删除源分支」，之后不论在网页上还是用工具合并，GitLab 都会删除源分支。GitHub 的 PR 没有对应选项，网页合并后的分支由仓库设置「Automatically delete head branches」或下面的 `repo_branch_delete` 清理。
- `repo_mr_merge` 合并后删除源分支：GitHub 在合并成功后删除，GitLab 在合并请求里带上 `should_remove_source_branch`。来自 fork 的分支和默认分支不删，GitLab 也不会删受保护分支。删除失败不影响合并结果，结果的 `sourceBranch` 写明分支名、是否删除和没删的原因；GitHub 仓库已经自动删除了这个分支时按已删除报告。

`repo_branch_delete` 不受这个开关控制，跟随写操作审批，用来清理已经留下来的分支。它只删除同时满足以下条件的分支，其余情况拒绝，所以不会丢掉没合入的工作：

- 分支的最新提交是本仓库某个已合并 PR/MR 的 head 提交，即合并之后没有再推送新提交；否则以 `conflict` 拒绝。
- 没有从它发起、仍打开中的 PR/MR；否则以 `conflict` 拒绝。
- 不是默认分支，也不是受保护分支；否则以 `forbidden` 拒绝。

## `dshRepos` 服务

其他插件经 `ctx.get('dshRepos')` 取得服务，类型从 `dsh-repo/contract` 用 `import type` 引入，调用前检查 `version`：

```ts
import type { DshRepoService } from 'dsh-repo/contract'

const repos = ctx.get('dshRepos') as DshRepoService | undefined
if (repos?.version === 1) {
  const issue = await repos.getIssue('https://gitlab.example.com/team/orders', 12)
}
```

接口覆盖仓库信息、分支、提交、目录、文件、issue 与 PR/MR 的读写和合并，以及主机管理、本地镜像和可写工作区，完整定义见 [`src/contract.ts`](src/contract.ts)。服务版本是 2。`openWorkspace(url, { dir, baseBranch, commit, branch })` 在调用方给的目录（必须不存在）检出工作区，给出 `branch` 时接着这个已有分支修改，`workspaceChanges(dir)` 返回改动，`pushWorkspace(dir, { branch, message, author, session, trailers })` 提交并推送，规则见[改代码](#改代码)；调用方先用 `workspaceChanges` 检查改动范围再推送。`getBranch` 读取单个分支，分支不存在时返回 `undefined`。`deleteMergedBranch(repo, branch)` 删除已经合并的分支，`createChange` / `mergeChange` 的 `deleteSourceBranch` 让源分支在合并后删除，规则见[合并后的分支](#合并后的分支)。所有预期内的失败都以 `name === 'RepoError'` 的错误拒绝，`code` 取值为 `invalid`、`not-allowed`、`unauthenticated`、`forbidden`、`not-found`、`conflict`、`rate-limited`、`too-large`、`unavailable`。

### 提交尾注事件

`repo_workspace_push` 为某个 Agent 的会话提交改动之前，用 `ctx.parallel('repo/commit-trailers', event)` 通知其他插件。`event` 带 `session`（会话 id）和 `dir`（工作区目录），监听者调用 `event.add(token, value)` 追加尾注，写在 `DSH-Session:` 之后，按添加顺序排列。监听者应在返回（或返回的 promise 结束）之前调用 `add`；所有监听者都结束之后再调用 `add` 不生效，但某个监听者结束后、其他监听者还在运行时的调用仍会记下。规则：

- 尾注名以字母开头，只含字母、数字和 `-`，最长 64 个字符，不能是 `DSH-Session`；值是一行，1 到 200 个字符，不含控制字符。每次推送最多 20 条。不合规时推送以 `invalid` 失败。
- 任何监听者抛错时推送以 `unavailable` 失败，不提交任何内容。
- 只在工具调用里触发；服务调用直接传 `trailers`，规则相同。

监听者不需要依赖 dsh-repo 的包，在本地声明事件类型即可：

```ts
interface CommitTrailersEvent {
  readonly session: string
  readonly dir: string
  add(token: string, value: string): void
}

ctx.on('repo/commit-trailers', (event: CommitTrailersEvent) => {
  event.add('Feishu-User', '张三 <u_123>')
})
```

## 本地镜像

`syncMirror(url, { branch })` 把仓库拉取为只拉取、不检出的镜像，返回分支最新提交；`readMirrorFile`、`listMirrorTree` 直接从提交的 git 对象读文件和目录；`acquireSnapshot(url, commit)` 返回该提交的只读检出（`git worktree`），同一提交的持有者共用一份，全部 `release()` 且不再是最近一次同步的提交时删除。

- 镜像目录默认是 `$DSH_HOME/dsh-repo/mirrors`，可以在「代码仓库」设置页手动输入或用系统目录选择框（本机 GUI 会话可用）换到别处，也可以由其他插件调用 `setMirrorDir`。所选目录保存在设置文件（默认 `$DSH_HOME/dsh-repo/hosts.json`）的 `mirrorDir` 字段，不写 cordis.yml；恢复默认时删除该字段。目录不存在时创建，无法创建或写入时拒绝。换目录后旧目录里的镜像不搬也不删，之后的同步在新目录重新克隆；已经持有的快照留在旧目录直到释放。每次换目录都经 `onHostsChange` 通知（`kind: 'mirror'`）。
- 镜像和主机文件都在 DSH 主目录下，不在插件的安装目录里，升级、卸载或重装插件不会删除它们。
- 镜像位于 `<镜像目录>/<主机>/<路径>`，本地路径位于 `<镜像目录>/local/`；快照位于 `<镜像目录>/.snapshots/` 下对应位置。新地址先克隆到临时目录再改名；同一镜像的 clone/fetch 依次执行。进程内第一次同步某个镜像时清理上次运行遗留的快照。
- 地址只接受 HTTPS URL、`file:` URL 或绝对路径；SSH 地址、`user@host:path`、`git://` 和 `http://` 以 `invalid` 拒绝，请改用仓库的 HTTPS 地址。属于已配置主机的地址受 `repos` 范围限制，并自动使用该主机的令牌（GitLab 用户名 `oauth2`，GitHub 用户名 `x-access-token`），令牌经只对这次 git 进程生效的凭据助手传入，不出现在命令行、`.git/config` 或输出里，Agent 也拿不到。其他主机上的仓库不带凭据拉取（适合公开仓库），设置页关闭「其他主机上的仓库」（`mirror.otherHosts`）时拒绝；本地路径不需要凭据。
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
| 合并后删除源分支 | GitLab 创建 MR 时勾选 `remove_source_branch`、合并时带 `should_remove_source_branch`；GitHub 没有逐个 PR 的选项，合并成功后删除 `heads/<分支>` |

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
