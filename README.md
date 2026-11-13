# Github-Operate

用于练习 IDEA 中的 Git 分支、代码合并与冲突解决的 Spring Boot 项目。

## Git 图解实验室（独立网页）

双击 [`webui/index.html`](webui/index.html) 即可打开，不需要运行 Java、安装 npm 依赖或联网。页面使用本地普通脚本与 SVG，所有 Git 操作只影响页面中的虚拟仓库，不读写真实仓库，也不会连接 GitHub。

- 六个练习场景：基础提交、分支与合并、合并冲突、变基、Reset 对比、远程协作。
- 蓝色画布中的 C0、C1 等圆点代表模拟提交，箭头指向父提交；亮绿色 `main*` 等标签标出当前分支，HEAD 跟随该分支。虚线淡化节点表示失去引用的历史，紫色节点表示远程尚未下载的提交。
- 在文件区编辑并保存，然后输入 `git add hello.txt`、`git commit -m "第一次修改"`。三个区域分别展示 HEAD、暂存区及工作区内容，暂存后继续编辑不会改变已暂存快照。执行命令或切换文件时会自动保存当前编辑草稿；重置/切换场景和刷新页面会清空当前练习。
- 冲突发生后，编辑工作区中的冲突标记，保存并 `git add`，然后使用对应的 `--continue`；`--abort` 恢复操作前状态。`add` 与真实 Git 一样会标记冲突已解决，即使文件中还留有标记，请自行检查。
- “模拟他人提交”只推进虚拟远程。对比远程实际状态与本地 `origin/main`，再尝试 fetch、pull、push。普通 pull 在练习中默认配置为 merge。
- 点击提交节点查看快照；“重播变化”只回放图形，不会重复执行命令。支持命令历史上下键、节点键盘访问、窄屏布局及系统减少动画偏好。

### 支持的命令

命令可带 `git` 前缀；含空格的文件名和说明需要加引号。页面的“命令手册”包含可点击示例。

| 类别 | 支持写法 |
| --- | --- |
| 查看 | `status`；`log [--oneline] [--graph] [--all]`；`diff [--cached]` |
| 暂存、提交 | `add <文件…>`、`add .`；`commit -m "说明"` |
| 分支 | `branch`、`branch <名称>`、`branch -d <名称>`；`switch <分支>`、`switch -c <名称>`；`checkout <分支或提交>`、`checkout -b <名称>` |
| 合并、变基 | `merge [--no-ff] <引用>`；`rebase <引用>`；两者均支持 `--continue`、`--abort` |
| 撤回 | `reset [--soft或--mixed或--hard] [提交]`（默认 mixed、HEAD）；`revert <普通提交>`、`revert --continue`、`revert --abort` |
| 虚拟远程 | `fetch [origin]`；`pull [--rebase或--no-rebase] [origin [分支]]`；`push [origin [分支]]`、`push -u origin <分支>` |

引用支持本地分支、`origin/<分支>`、C 编号、唯一的 4–7 位模拟短 ID、`HEAD`、`HEAD~n`、`HEAD^` 和指定父提交的 `HEAD^2`。C 编号及短 ID 都不是实际 Git 对象哈希。图中保留失去引用的对象供教学比较，`log --all` 只列出本地引用可达的历史；文本 `--graph` 以父提交列表表达拓扑，完整连线以画布为准。

### 教学边界与验证

只支持普通文本，每个文件最多 300 行、20000 个字符。merge、rebase、revert、pull 开始前要求工作区和暂存区干净，这是本教学版的支持边界。暂不支持二进制、重命名检测、文件/目录合并冲突、多个最佳合并基点、交互式 rebase、重放合并提交、撤回合并提交、强制推送及未列出的其他参数；未知写法会明确提示，不会伪造成功。仅在当前页面内保留状态，无账号或持久化。

在项目根目录使用 Node.js 22 或更新版本运行独立网页测试：

```powershell
node --test webui/tests/simulator.test.cjs webui/tests/graph.test.cjs webui/tests/git-reference.test.cjs
```

真实 Git 对照测试还需要本机 `git` 命令；仅在 `target/webui-validation/` 中创建并清理独立临时仓库与本地裸仓库，比较文件、暂存区、引用和父子拓扑，不连接网络，也不修改开发仓库。网页本身不需要 Node.js 或 Git。

命令语义参考 Git 官方的 [merge](https://git-scm.com/docs/git-merge)、[rebase](https://git-scm.com/docs/git-rebase)、[reset](https://git-scm.com/docs/git-reset)、[revert](https://git-scm.com/docs/git-revert) 和 [push](https://git-scm.com/docs/git-push) 说明。

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
