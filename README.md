# Github-Operate

用于练习 IDEA 中的 Git 分支、代码合并与冲突解决的 Spring Boot 项目。

## Git 图解实验室（独立网页）

日常使用桌面的 **Git 图解实验室** 快捷方式：双击会自动启动本地服务并打开 <http://127.0.0.1:17898/>，无需去项目目录寻找文件。重复双击会复用已有服务。服务按需启动，不注册 Windows 登录启动任务。

启动需要 Windows 与 PowerShell 7，不需要 Java、Python、Node.js、npm 或网络。服务只监听 `127.0.0.1:17898`，仅提供 WebUI 静态资源，不读写真实 Git 仓库，也不连接 GitHub。双击 [`webui/index.html`](webui/index.html) 仍可直接离线打开。

### 后台服务管理

- 双击 [`停止Git图解实验室.cmd`](停止Git图解实验室.cmd) 停止后台服务；下次双击桌面快捷方式会重新启动。
- 服务以当前用户权限隐藏运行，日志位于 `target/webui-service/service.log`；也可使用根目录的 [`启动Git图解实验室.cmd`](启动Git图解实验室.cmd) 启动。
- 端口被其他程序占用时会明确报错，不会终止其他进程；停止操作会核对服务身份、可执行文件与参数。

在项目根目录的 PowerShell 7 中也可以执行：

```powershell
.\scripts\GitPlayground.ps1 -Action Shortcut    # 在新电脑创建或恢复桌面快捷方式
.\scripts\GitPlayground.ps1 -Action Start       # 启动并打开浏览器
.\scripts\GitPlayground.ps1 -Action Start -NoBrowser
.\scripts\GitPlayground.ps1 -Action Status
.\scripts\GitPlayground.ps1 -Action Stop
```

关闭浏览器不会停止后台服务。每个浏览器页面仍有各自独立的虚拟练习，服务不会保存练习状态；刷新会重新开始。

- 六个练习场景：基础提交、分支与合并、合并冲突、变基、Reset 对比、远程协作。
- 提交图上方的“参考答案与验收”可展开查看本关目标、逐条参考命令、文件编辑示例及预期结果。点击命令只填入输入框；右侧完成数量与下方验收条件随仓库及编辑草稿更新，完成后继续修改也可能回到待完成。
- 分支整合与远程协作可分别选 merge / rebase 方案；Reset 提供 soft / mixed / hard 三套答案。切换参考方案只改变说明和验收标准，比较另一方案前请先“重置场景”；重置会清空本轮验收记录。Reset 的 soft / mixed 完成时保留文件改动是预期结果。
- 冲突练习接受你认可的最终文本，会检查冲突标记、暂存结果与提交关系；自动验收不判断文字的业务含义。参考答案只针对内置练习目标，不等同于任意复杂仓库的正确性证明。
- 蓝色画布中的 C0、C1 等圆点代表模拟提交，箭头指向父提交；亮绿色 `main*` 等标签标出当前分支，HEAD 跟随该分支。虚线淡化节点表示失去引用的历史，紫色节点表示远程尚未下载的提交。
- 在文件区编辑并保存，然后输入 `git add hello.txt`、`git commit -m "第一次修改"`。三个区域分别展示 HEAD、暂存区及工作区内容，暂存后继续编辑不会改变已暂存快照。执行命令或切换文件时会自动保存当前编辑草稿；重置/切换场景和刷新页面会清空当前练习。
- 冲突发生后，编辑工作区中的冲突标记，保存并 `git add`，然后使用对应的 `--continue`；`--abort` 恢复操作前状态。`add` 与真实 Git 一样会标记冲突已解决，即使文件中还留有标记，请自行检查。
- “模拟他人提交”一键在远程 `team.txt` 追加一行，提交说明写明文件名与新增文字；命令结果和自动展开的提交详情都会展示本次修改。只推进虚拟远程，本地文件、暂存区和 `origin/main` 保持原样；fetch 下载提交，pull 才整合到本地。普通 pull 在练习中默认配置为 merge。
- “提交到远程分支”可选择 `main`、`dev` 等已有远程分支；选择独立于当前本地分支，执行命令后保留，切换或重置场景后恢复默认。仅本地存在的分支会标注“需先 push”，例如先执行 `git push -u origin dev`，再选择远程 `dev` 模拟协作者提交。只有所选远程分支前进，其他远程分支、本地分支及 `origin/*` 均不随之移动。
- 点击提交节点优先查看本次改动：绿色 `+` 表示新增行，红色 `−` 表示删除行，文件标明新增、修改或删除；合并提交对比第一父提交，初始提交对比空仓库。完整文件快照可展开查看，主图和放大图展示一致。“重播变化”只回放图形，不会重复执行命令。支持命令历史上下键、节点键盘访问、窄屏布局及系统减少动画偏好。
- 点击提交图或图上方“放大查看”可弹出大图，支持缩放、查看节点快照，按 Esc、点击遮罩或“关闭”返回。返回时保留原画布缩放、滚动位置和编辑草稿，打开大图不会执行 Git 命令。
- 命令行支持命令、选项、文件名、分支和提交引用补全。输入时按 `Tab` 填入首个候选，或用 `↑ ↓` 选择后按 `Enter` 确认，再按 `Enter` 执行；`Esc` 关闭候选，`Ctrl+Space` 手动唤出。候选关闭时 `↑ ↓` 仍浏览历史命令，中文输入法选字期间不会触发补全。
- “接下来可以试试”会根据工作区、暂存区、冲突与远程状态推荐下一步，并说明原因。点击只填入命令；提交说明可直接修改，命令始终由你确认执行。

### 支持的命令

命令可带 `git` 前缀；含空格的文件名和说明需要加引号。页面的“命令手册”包含可点击示例，以及标记为“仅供参考”的真实终端命令；参考项不会填入或执行，不代表模拟器支持其参数。

命令手册顶部可模糊搜索全部分类中的命令、参数、中文说明和组合流程，例如 `rebase`、`--hard`、`取消暂存`。支持命令片段、按顺序省略字符，以及英文长词的一个错字或相邻字母颠倒（如 `rbase`、`swtch`、`rebsae`）；多个关键词用空格分隔，同时匹配，不区分英文大小写。搜索结果仍可点击填入命令。点击“清空”或在搜索框按 Esc 恢复原来的浏览分类；搜索框为空时 Esc 关闭手册。

手册还包含 `git switch -c <your-branch-name>`、restore、stash、show 等命令模板，以及提交并推送、首次发布新分支、更新主分支、取消全部暂存、合并分支后清理、冲突处理和临时保存切换等流程。尖括号中的内容是待替换的占位符；点击模板会填入有效示例并选中待修改内容。含 `&&` 的整行命令用于 PowerShell 7、Git Bash 等真实终端，网页中可点击流程下的分步按钮逐条练习；不会自动执行组合命令。冲突流程按当前操作选择合并或变基对应的卡片。

| 类别 | 支持写法 |
| --- | --- |
| 查看 | `status`；`log [--oneline] [--graph] [--all]`；`diff [--cached]`；`show [提交引用]`；`reflog [--oneline]` |
| 暂存、提交 | `add <文件…>`、`add .`；`commit [-a] -m "说明"`、`commit -am "说明"`；`commit --amend -m "说明"`、`commit --amend --no-edit`（可加 `-a`） |
| 取消暂存、恢复 | `restore --staged <文件…>`、`restore --staged .`；`restore <文件…>`、`restore .`（从暂存区恢复工作区，会丢弃未暂存修改） |
| 临时保存 | `stash`、`stash push [-u] [-m "说明"]`；`stash list`；`stash pop/apply/drop [stash@{n}]`（省略时最近一份）；`stash clear` |
| 文件 | `rm [--cached] <文件…>`；`mv <原文件> <新文件>`（仅明确文件路径） |
| 分支 | `branch [-a] [-vv]`、`branch <名称> [引用]`、`branch -m [旧名] <新名>`、`branch -d <名称>`；`switch <分支>`、`switch -c <名称>`；`checkout <分支或提交>`、`checkout -b <名称>`；两者均支持 `-` 和 `--detach [引用]` |
| checkout 恢复文件 | `checkout -- <文件…>`（暂存区到工作区）；`checkout <引用> -- <文件…>`（该提交到暂存区及工作区）；均支持 `.` |
| 合并、变基 | `merge [--no-ff] <引用>`；`rebase <引用>`；两者均支持 `--continue`、`--abort` |
| 摘取提交 | `cherry-pick <普通提交…>`（明确列出的顺序）；`cherry-pick --continue`、`--skip`、`--abort` |
| 本地标签 | `tag`、`tag -l`；`tag <名称> [引用]`；`tag -a <名称> [引用] -m "说明"`；`tag -d <名称>` |
| 撤回 | `reset [--soft或--mixed或--hard] [提交]`（默认 mixed、HEAD）；`revert <普通提交>`、`revert --continue`、`revert --abort` |
| 虚拟远程 | `remote [-v]`（仅展示虚拟 origin，无真实地址）；`fetch [origin]`；`pull [--rebase或--no-rebase] [origin [分支]]`；`push [origin [分支]]`、`push -u origin <分支>` |

引用支持本地分支、本地标签、`origin/<分支>`、C 编号、唯一的 4–7 位模拟短 ID、`HEAD`、`HEAD~n`、`HEAD^`、指定父提交的 `HEAD^2` 和本次会话的 `HEAD@{n}`。C 编号及短 ID 都不是实际 Git 对象哈希。图中保留失去引用的对象供教学比较，`log --all` 只列出本地引用（含标签）可达的历史；文本 `--graph` 以父提交列表表达拓扑，完整连线以画布为准。

`checkout main` 与 `switch main` 都切换分支，`checkout -b feature` 与 `switch -c feature` 都创建并切换。checkout 还兼有恢复文件的用途，`checkout -- hello.txt` 对应 `restore hello.txt`；不能将所有 checkout 都直接换成 switch。switch 支持显式 `--detach` 查看提交。`checkout HEAD -- hello.txt` 同时覆盖该文件的暂存区和工作区，与默认 restore 的来源、目标不同。

手册还列出 init、clone、作者配置、远程地址配置、fetch --prune、删除远程分支、推送标签、文件历史、提交间 diff、cherry、blame、交互式 rebase、clean 预览和忽略规则检查。这些为真实终端参考，附官方链接；模拟器不执行。

### 教学边界与验证

只支持普通文本，每个文件最多 300 行、20000 个字符。merge、rebase、revert、cherry-pick、pull 开始前要求工作区和暂存区干净，这是本教学版的支持边界。暂不支持二进制、重命名检测、文件/目录合并冲突、多个最佳合并基点、交互式 rebase、重放或摘取合并提交、撤回合并提交、强制推送及未列出的其他参数；未知写法会明确提示，不会伪造成功。仅在当前页面内保留状态，无账号或持久化。

restore 支持明确文件名与 `.`，不支持目录路径匹配、`--source` 或在未解决冲突时恢复文件。`restore --staged` 保留工作区；普通 restore 从暂存区恢复，不从 HEAD 恢复。`show` 对普通提交显示与父提交的差异，根提交与空快照比较；合并提交按教学方式分别与每个父提交比较。

stash 默认保存已跟踪改动，`-u` 包含未跟踪文件。教学版使用独立快照栈保存，不在提交图中模拟 stash 的内部提交结构，不支持 `--index`。pop/apply 可指定 `stash@{n}`，恢复前要求已跟踪文件与暂存区干净，遇到文件覆盖或目录冲突会整体拒绝。pop 成功后移除指定记录，apply 保留记录；普通修改需重新 add，已跟踪的新增文件恢复到暂存区；冲突时均保留记录，编辑后 add 标记全部解决，即可正常提交，无需 `--continue`。drop 删除指定记录，clear 清空全部记录，均不改变文件。可用 `reset --hard` 丢弃恢复产生的已跟踪改动，stash 记录仍保留。stash 随刷新或场景重置清空。

cherry-pick 应用指定提交相对父提交的改动，生成新的普通提交，来源分支不移动。支持明确列出的多个提交，不支持修订范围、`-m` 主线选择、`--no-commit`。冲突后编辑、add，再 `--continue`；`--skip` 丢弃当前解决结果并继续下一项，`--abort` 恢复整批开始前的位置和文件。重复补丁或解决后没有改动时暂停，需要 skip 或 abort，不创建空提交。可在“分支与合并”场景单独练习摘取，但它不等同于该关 merge/rebase 路线的验收。

`commit -a/-am` 只自动暂存已跟踪文件，未跟踪文件仍须 add。amend 用暂存区内容及原父提交生成新提交，原 ID 仍保留供观察。标签固定指向提交，在图中显示 `tag:`；注解仅存为教学元数据，不模拟独立 tag 对象、签名或标签同步。分支和标签重名时教学版优先解析分支，建议使用不同名称。

reflog 是本次页面会话中每条命令最终 HEAD 位置的教学记录，批量 cherry-pick 和 rebase 的内部移动不逐步记录，也不模拟真实 Git 的磁盘日志、过期和回收。可先 reflog，再 `branch rescue HEAD@{n}` 保存旧位置；编号随新记录变化，刷新或切换场景清空。

在项目根目录使用 Node.js 22 或更新版本运行独立网页测试：

```powershell
node --test webui/tests/*.test.cjs
```

真实 Git 对照测试还需要本机 `git` 命令；仅在 `target/webui-validation/` 中创建并清理独立临时仓库与本地裸仓库，比较文件、暂存区、引用和父子拓扑，不连接网络，也不修改开发仓库。网页本身不需要 Node.js 或 Git。

命令语义参考 Git 官方的 [merge](https://git-scm.com/docs/git-merge)、[rebase](https://git-scm.com/docs/git-rebase)、[reset](https://git-scm.com/docs/git-reset)、[revert](https://git-scm.com/docs/git-revert)、[push](https://git-scm.com/docs/git-push)、[restore](https://git-scm.com/docs/git-restore)、[stash](https://git-scm.com/docs/git-stash)、[show](https://git-scm.com/docs/git-show)、[branch](https://git-scm.com/docs/git-branch)、[remote](https://git-scm.com/docs/git-remote)、[cherry-pick](https://git-scm.com/docs/git-cherry-pick)、[checkout](https://git-scm.com/docs/git-checkout)、[switch](https://git-scm.com/docs/git-switch)、[commit](https://git-scm.com/docs/git-commit)、[rm](https://git-scm.com/docs/git-rm)、[mv](https://git-scm.com/docs/git-mv)、[tag](https://git-scm.com/docs/git-tag) 和 [reflog](https://git-scm.com/docs/git-reflog) 说明。

## 环境

- Java 21
- Spring Boot 4.1.1
- Maven Wrapper 3.9.16（已包含，无需额外安装 Maven）
- 无数据库及其他外部服务依赖

## 在 IDEA 中打开

1. 使用 **File → Open** 选择项目目录或 `pom.xml`，作为 Maven 项目导入。
2. 将 Project SDK 和 Maven Runner 的 JRE 设置为 JDK 21，等待依赖下载完成。
3. 运行 `com.example.githuboperate.GithubOperateApplication` 的 `main` 方法。
4. 打开 <http://localhost:8080/api/greeting>，预期返回：

```json
{"message":"欢迎学习 Git 分支合并！"}
```

也可以在 Windows Terminal 的 PowerShell 中从项目根目录运行：

```powershell
.\mvnw.cmd spring-boot:run
```

按 `Ctrl+C` 停止服务。默认端口为 8080。

## 验证

```powershell
.\mvnw.cmd verify
```

此命令执行编译、接口测试和可执行 JAR 打包；测试使用模拟 Web 环境，不占用 8080 端口。

## Git 与 GitHub

- 主分支：`main`。
- 私有仓库：[zibuyu9190/Github-Operate](https://github.com/zibuyu9190/Github-Operate)。
- `target/`、IDEA 配置和编译产物不纳入版本管理。
- 后续从相同的初始提交创建 `A`、`B` 分支：我在 `A` 开发，你在 `B` 开发，再由你在 IDEA 中练习合并和解决冲突。

Git 记录本地提交与合并，GitHub 托管推送后的提交。Push 负责上传提交；合并与冲突处理在整合分支时完成。
