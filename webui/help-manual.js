/* 命令手册、复合操作说明与模糊搜索；点击示例只填入输入框，不执行命令。 */
(function (root) {
  'use strict';

  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

  /** 省略字符仍按原顺序匹配；英文长词额外容忍一次编辑或相邻字母颠倒，避免短词过度匹配。 */
  function fuzzyWord(term, word) {
    let index = 0;
    for (const char of word) {
      if (char === term[index]) index++;
    }
    if (index === term.length) return true;
    if (!/^[a-z-]{4,}$/.test(term) || !/^[a-z-]{4,}$/.test(word) || Math.abs(term.length - word.length) > 1) {
      return false;
    }
    let previous = Array.from({ length: word.length + 1 }, (_, i) => i);
    let beforePrevious;
    for (let i = 1; i <= term.length; i++) {
      const row = [i];
      for (let j = 1; j <= word.length; j++) {
        row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (term[i - 1] === word[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && term[i - 1] === word[j - 2] && term[i - 2] === word[j - 1]) {
          row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
        }
      }
      beforePrevious = previous;
      previous = row;
    }
    return previous[word.length] <= 1;
  }

  const TEMPLATES = [
    ['git switch -c <your-branch-name>', '创建并切换到新分支，例如 feature-demo。分支刚创建时与原分支指向同一提交。', 'git switch -c feature-demo', 'feature-demo'],
    ['git switch <your-branch-name>', '切换到已存在的本地分支；切换前留意未提交的改动。', 'git switch main', 'main'],
    ['git branch <your-branch-name>', '只创建分支，不切换；需要在不同分支分别提交，图中才会出现分叉。', 'git branch feature-demo', 'feature-demo'],
    ['git checkout -b <your-branch-name>', '创建并切换分支，是 switch -c 的另一种写法。', 'git checkout -b feature-demo', 'feature-demo'],
    ['git add <file-path>', '暂存指定文件，例如 hello.txt；add . 会暂存全部新增、修改和删除。', 'git add hello.txt', 'hello.txt'],
    ['git restore --staged <file-path>', '取消指定文件暂存，保留工作区修改；取消全部暂存也可用 git reset --mixed HEAD。', 'git restore --staged hello.txt', 'hello.txt'],
    ['git restore <file-path>', '从暂存区恢复工作区文件，会丢弃该文件尚未暂存的修改。', 'git restore hello.txt', 'hello.txt'],
    ['git stash push -u -m "<message>"', '临时保存已跟踪及未跟踪文件，切换分支处理其他任务后用 stash pop 恢复。', 'git stash push -u -m "临时保存"', '临时保存'],
    ['git show <commit>', '查看指定提交的说明和具体修改，例如 HEAD、HEAD~1 或图中的 C 编号。', 'git show HEAD', 'HEAD'],
    ['git commit -m "<message>"', '提交暂存区；把 message 换成本次修改说明。commit 本身不会推送。', 'git commit -m "完成本次修改"', '完成本次修改'],
    ['git merge <your-branch-name>', '把指定分支合并到当前所在分支，不会切换分支。', 'git merge bugFix', 'bugFix'],
    ['git push -u origin <your-branch-name>', '首次发布本地分支并设置上游；后续在该分支通常可直接 git push。', 'git push -u origin feature-demo', 'feature-demo']
  ];

  const WORKFLOWS = [
    ['提交并推送', 'git commit -m "<message>" && git push', '适合已有暂存改动，且当前分支已设置上游的情况。', [['git commit -m "完成本次修改"', '完成本次修改'], ['git push']]],
    ['暂存全部改动、提交并推送', 'git add . && git commit -m "<message>" && git push', '先编辑文件，再暂存、提交和推送；当前分支需要已设置上游。没有可提交的改动时，commit 会失败，后续 push 不会执行。', [['git add .'], ['git commit -m "完成本次修改"', '完成本次修改'], ['git push']]],
    ['提交并首次发布新分支', 'git add . && git commit -m "<message>" && git push -u origin <your-branch-name>', '先用 switch -c 创建并切换分支，再编辑文件。把最后的分支名换成当前分支名，首次推送后会建立跟踪关系。', [['git add .'], ['git commit -m "完成本次修改"', '完成本次修改'], ['git push -u origin feature-demo', 'feature-demo']]],
    ['切换主分支并更新', 'git switch main && git pull --no-rebase origin main', '先保存并提交改动，保持工作区干净，再切换 main 并合并远程更新。', [['git switch main'], ['git pull --no-rebase origin main']]],
    ['取消全部暂存，保留修改', 'git reset --mixed HEAD', '暂存区回到 HEAD，工作区内容保留。随后可以重新选择文件 add；不会撤回提交。', [['git reset --mixed HEAD']]],
    ['合并功能分支并清理', 'git switch main && git merge <your-branch-name> && git branch -d <your-branch-name>', '先保持工作区干净，再合入功能分支。发生冲突时先解决，合并成功后再删除分支；已设置上游的分支还须已合入上游，-d 才允许删除。', [['git switch main'], ['git merge feature-demo', 'feature-demo'], ['git branch -d feature-demo', 'feature-demo']]],
    ['解决合并冲突后继续', 'git add <file-path> && git merge --continue', '先编辑并保存最终内容，删除所有冲突标记，再 add 所有解决文件。merge --continue 会完成合并提交，无需再单独 commit；还有未解决冲突时不能继续。', [['git add hello.txt', 'hello.txt'], ['git merge --continue']]],
    ['解决变基冲突后继续', 'git add <file-path> && git rebase --continue', '编辑并保存当前重放提交的冲突，add 后继续；后续提交可能再次暂停。stash pop 冲突全部 add 后即可正常提交，没有 --continue。', [['git add hello.txt', 'hello.txt'], ['git rebase --continue']]],
    ['临时保存，切换分支，再恢复', 'git stash push -u -m "临时保存" && git switch <your-branch-name> && git stash pop', '保存当前改动后切换到已存在的目标分支，再恢复改动。pop 成功后移除记录，冲突时保留；可先 stash list 核对。', [['git stash push -u -m "临时保存"'], ['git switch main', 'main'], ['git stash list'], ['git stash pop']]]
  ];

  const MANUAL = [
    ['查看状态与差异', [['git status', '查看三个区域和同步状态'], ['git log --oneline --graph --all', '可达历史；文本列出父提交'], ['git show HEAD', '查看提交说明与改动；也可指定分支或提交 ID'], ['git diff', '工作区与暂存区差异'], ['git diff --cached', '暂存区与 HEAD 差异']]],
    ['暂存、提交与临时保存', [['git add hello.txt', '支持多个文件，含空格的路径加引号'], ['git add .', '暂存所有新增、修改和删除'], ['git restore --staged hello.txt', '取消该文件暂存，保留工作区修改'], ['git restore hello.txt', '恢复为暂存区内容，丢弃该文件未暂存修改'], ['git restore --staged .', '取消全部暂存，保留工作区修改'], ['git commit -m "学习 Git"', '提交暂存内容，中文说明可用'], ['git stash push -m "临时保存"', '保存已跟踪改动；未跟踪文件保留在工作区'], ['git stash push -u -m "临时保存"', '连未跟踪文件一起保存，HEAD 不变'], ['git stash list', '列出保存记录，stash@{0} 为最近一份'], ['git stash pop', '恢复最近一份，成功后移除，冲突时保留；普通修改需重新 add']]],
    ['分支与切换', [['git branch', '列出本地分支'], ['git branch -a', '列出本地与远程跟踪分支'], ['git branch -vv', '查看上游以及领先/落后数量，依据最近同步'], ['git branch bugFix', '在当前提交创建分支'], ['git branch -d bugFix', '仅删除已合入目标的非当前分支'], ['git switch -c feature', '创建并切换分支'], ['git switch main', '切换已有本地分支'], ['git checkout -b feature', '创建并切换分支'], ['git checkout C0', '切换分支或提交；提交进入分离 HEAD']]],
    ['提交引用', [['git checkout HEAD~1', '第一父链向前一代，支持 HEAD~n'], ['git checkout HEAD^', '默认第一个父提交；也可用 ^2'], ['git checkout 0000001', '模拟短 ID；也可直接用 C0'], ['git merge origin/main', '使用最近 fetch 的本地远程跟踪引用']]],
    ['合并', [['git merge bugFix', '快进或创建双亲提交'], ['git merge --no-ff bugFix', '需要合并时强制创建合并提交'], ['git merge --continue', '解决冲突并 add 后完成合并提交，无需再单独 commit'], ['git merge --abort', '恢复操作前状态']]],
    ['变基', [['git rebase main', '将当前线性分支重放到目标之上'], ['git rebase --continue', '解决冲突并 add 后继续'], ['git rebase --abort', '恢复变基前状态']]],
    ['Reset 与 Revert', [['git reset --soft HEAD~1', '只移动分支/HEAD'], ['git reset --mixed HEAD~1', '同时重置暂存区；省略模式时默认 mixed'], ['git reset --mixed HEAD', '取消全部暂存，保留工作区修改和当前提交'], ['git reset --hard HEAD~1', '同时重置已跟踪文件，未跟踪文件通常保留'], ['git reset', '默认 mixed，目标默认 HEAD'], ['git revert HEAD', '用新提交抵消一个普通提交'], ['git revert --continue', '解决冲突并 add 后继续'], ['git revert --abort', '中止撤回']]],
    ['虚拟远程协作', [['git remote -v', '查看虚拟 origin；不读取真实仓库地址'], ['git fetch origin', '只下载对象、更新 origin/*'], ['git pull', '本练习先 fetch，再 merge；无参数时需要已配置上游'], ['git pull --no-rebase origin main', '先 fetch，再用 merge 整合到当前分支'], ['git pull --rebase origin main', '先 fetch，再用 rebase 整合到当前分支'], ['git push', '推送到当前分支的上游'], ['git push origin main', '推送指定同名分支'], ['git push -u origin bugFix', '推送并设置上游']]]
  ];

  const DAILY_COMMANDS = [
    ['git cherry-pick bugFix', '把 bugFix 最新普通提交的改动摘取到当前分支；可在“分支与合并”中单独尝试，摘取不等同于该关合并路线的验收。'],
    ['git cherry-pick C1 C2', '按输入顺序摘取多个普通提交；先用 show 确认要拿的改动。'],
    ['git cherry-pick --continue', '编辑冲突、保存并 add 后继续；后续提交仍可能冲突。'],
    ['git cherry-pick --skip', '丢弃当前摘取结果，跳过当前提交；空改动也可跳过。'],
    ['git cherry-pick --abort', '恢复整批摘取开始前的位置和文件。'],
    ['git commit -am "修改已跟踪文件"', '自动暂存已跟踪文件的修改、删除并提交；不包含未跟踪的新文件。'],
    ['git commit --amend -m "更新提交说明"', '替换最近一次提交；用暂存区内容和原父提交创建新 ID，改写前先核对是否已共享。'],
    ['git commit --amend --no-edit', '补充暂存的改动，沿用最近一次提交说明。'],
    ['git branch -m feature-renamed', '修改当前本地分支名称，原上游配置保留。'],
    ['git branch rescue HEAD@{1}', '在此前的 HEAD 位置创建救援分支，不切换当前分支。'],
    ['git switch -', '回到上一次分支切换的位置。'],
    ['git switch --detach HEAD~1', '直接查看某个提交，进入分离 HEAD；可用 switch -c 保存后续开发。'],
    ['git checkout -- hello.txt', '从暂存区恢复工作区文件，相当于 git restore hello.txt。'],
    ['git checkout HEAD -- hello.txt', '同时把暂存区和工作区中的该文件恢复为 HEAD；不会切换分支。'],
    ['git rm hello.txt', '删除工作区与暂存项并暂存删除；存在未提交修改时会保护性拒绝。'],
    ['git rm --cached hello.txt', '仅取消跟踪，工作区文件保留；不等于取消暂存。'],
    ['git mv hello.txt greeting.txt', '移动文件并暂存路径变化；原未暂存内容仍未暂存。'],
    ['git tag', '列出本地版本标签。'],
    ['git tag v1.0', '给当前提交打轻量标签；标签不会随分支前进。'],
    ['git tag -a v1.1 -m "版本说明"', '添加带说明的本地标签；教学版只存说明，不模拟独立 tag 对象或签名。'],
    ['git tag -d v1.0', '删除本地标签，不删除提交。'],
    ['git reflog', '列出当前会话每条命令的最终 HEAD 位置，批量操作的内部移动不逐步记录；可用 HEAD@{n} 找回位置。'],
    ['git stash apply', '恢复最近一份临时改动，并保留记录。'],
    ['git stash pop stash@{1}', '恢复第二份记录，成功后移除；编号会随保存和删除变化。'],
    ['git stash drop stash@{0}', '删除指定的虚拟临时记录，文件与提交不变。'],
    ['git stash clear', '清空全部虚拟临时记录。']
  ];

  const EXTERNAL_COMMANDS = [
    ['git init -b main', '在当前目录初始化真实仓库。', 'git-init'],
    ['git clone <repository-url>', '下载仓库并自动配置 origin；地址由项目提供。', 'git-clone'],
    ['git config --global user.name "你的名字"', '设置后续真实提交的作者姓名，非登录账号。', 'git-config'],
    ['git config --global user.email "你的邮箱"', '设置提交邮箱；查看配置用 git config --list。', 'git-config'],
    ['git remote add origin <repository-url>', '给真实仓库添加远程；已有 origin 时用 remote set-url origin <repository-url>。', 'git-remote'],
    ['git fetch --prune origin', '获取更新，并清理远端已删除分支对应的本地跟踪引用。', 'git-fetch'],
    ['git push origin --delete <branch-name>', '删除远程分支，先确认团队不再使用。', 'git-push'],
    ['git push origin --tags', '推送本地标签；网页标签只保存在虚拟仓库。', 'git-push'],
    ['git log -p -- <file-path>', '查看某个文件的提交历史和补丁；-- 之后是路径。', 'git-log'],
    ['git diff <commit-a> <commit-b>', '比较两个提交的内容。网页 diff 仅支持工作区和暂存区的基础对比。', 'git-diff'],
    ['git cherry -v origin/main', '按补丁等价性检查哪些改动尚未进入上游；与 cherry-pick 的摘取用途不同。', 'git-cherry'],
    ['git blame -- <file-path>', '查看各行最近一次修改的提交来源。', 'git-blame'],
    ['git rebase -i HEAD~3', '交互式整理最近三个提交，操作前核对是否已共享。网页仅支持普通 rebase。', 'git-rebase'],
    ['git clean -nd', '预览将被清理的未跟踪文件和目录；此条只预览。', 'git-clean'],
    ['git check-ignore -v <file-path>', '检查 .gitignore 等规则为何忽略某个文件；已跟踪文件不会仅因加入忽略规则而取消跟踪。', 'git-check-ignore']
  ];

  // 仅解释手册中已有的写法，不参与命令解析。先生成说明，再建立搜索索引，折叠内容也能被检索。
  const OPERATION_GUIDES = [
    [/^git merge --continue$/, '检查合并状态 → commit 完成合并', '先编辑、保存并 add 所有冲突解决结果；此命令会检查是否有未完成的合并，再调用 commit。成功后已产生合并提交，无需再 commit；它不包含 add 或 push。真实终端可能打开提交说明编辑器。', 'merge'],
    [/^git merge (?:--no-ff )?[^-]/, '整合两条历史 → 需要时自动提交', '普通 merge 可以直接快进，此时不新增提交；分叉历史合并成功后默认创建合并提交，--no-ff 在需要合并时禁用快进。冲突会暂停，解决并 add 后才能 --continue；merge 不会先 fetch，也不会 push。', 'merge'],
    [/^git pull --no-rebase\b/, 'fetch → merge', '先获取远程更新，再合入当前分支；在常见 origin 配置下，可分步理解为 git fetch origin，再 git merge origin/main（示例目标是 main）。快进不新增提交；分叉合并通常生成合并提交，冲突时暂停。合并失败不会撤销已完成的 fetch。', 'pull'],
    [/^git pull --rebase\b/, 'fetch → rebase', '先获取远程更新，再将当前分支需要重放的提交放到目标之上；目标是 main 时可分步理解为 git fetch origin，再 git rebase origin/main。可能产生新提交 ID；冲突时先编辑并 add，再 rebase --continue，后续提交仍可能再次暂停。', 'pull'],
    [/^git pull$/, 'fetch → 按策略整合（本练习为 merge）', '无参数时使用当前分支的上游。本练习将普通 pull 配置为合并方式；真实 Git 的整合方式受参数、pull.rebase、pull.ff 等配置及版本影响，可能使用 merge、rebase，或仅允许快进。要明确选择，可写 --no-rebase 或 --rebase。', 'pull'],
    [/^git switch -c\b/, '创建分支 → 切换到新分支', '可理解为 git branch <新分支>，再 git switch <新分支>。switch -c 把两步作为一次操作，切换失败时不会留下刚创建的分支。创建分支不会产生提交，也不会自动发布到远程。', 'switch'],
    [/^git checkout -b\b/, '创建分支 → 切换到新分支', '在这里对应 switch -c；可理解为先 branch 创建，再 checkout 切换。仍须遵循未提交文件的切换保护；不会自动 commit 或 push。', 'checkout'],
    [/^git commit (?:-am\b|-a\s+-m\b)/, '暂存已跟踪文件的改动 → commit', '-a 自动暂存已跟踪文件的修改和删除，再与暂存区中已有内容一起提交；它不会自动加入未跟踪的新文件。已经 add 的新文件仍会随暂存区提交。此命令不包含 push，也不等于 add . 后 commit。', 'commit'],
    [/^git stash pop(?:\s|$)/, 'apply 恢复改动 → 成功后 drop 记录', '可理解为恢复指定 stash，恢复成功后再移除该记录；默认处理 stash@{0}。发生冲突时记录保留，先解决并 add，再自行核对是否 drop。不会自动 commit，也没有 stash --continue。', 'stash'],
    [/^git stash push(?:\s|$)/, '保存临时快照 → 清理已保存的改动', '把要保存的工作区和暂存区状态存入 stash，再将对应改动移出当前工作区和暂存区；默认处理已跟踪文件，-u 还包含未跟踪文件。没有改动时不会新增记录；HEAD 不前进，也不会 push。', 'stash'],
    [/^git push\b.*\s-u(?:\s|$)/, 'push 发布提交 → 设置上游关系', '分支推送成功或已经是最新时，-u 建立本地分支与远程分支的跟踪关系；推送被拒绝时不会因此建立上游。它不包含 add、commit、fetch 或 pull；未提交的编辑不会被推送。', 'push'],
    [/^git rebase --continue$/, '保存当前重放结果 → 继续后续提交', '先解决当前冲突并 add，再继续变基；通常会生成当前重放提交的新版本，然后继续处理剩余提交。后续仍可能冲突，并非所有情况一次 continue 就结束；它不包含 add 或 push。', 'rebase'],
    [/^git rebase [^-]/, '逐个重放改动 → 更新分支历史', '可把常见线性变基理解为在新基点上逐个重放需要保留的提交；实际重放会生成新的提交 ID。无需重放或可以快进时不必生成新提交；冲突会暂停。它不是普通 merge，也不会自行 fetch 或 push。', 'rebase'],
    [/^git cherry-pick --continue$/, '提交当前解决结果 → 继续剩余摘取', '先解决冲突并 add；继续时完成当前摘取提交，再处理同一批中剩余的提交。后续仍可能冲突；当前结果为空时需按提示处理，不能保证必定生成提交。', 'cherry-pick'],
    [/^git cherry-pick [^-]/, '应用指定提交的改动 → 创建新提交', '默认会为每个成功摘取的改动创建新提交，无需再手动 commit；不等于把整个分支 merge 过来。冲突时暂停，编辑并 add 后使用 cherry-pick --continue；空改动可能需要 --skip。', 'cherry-pick'],
    [/^git revert --continue$/, '提交反向改动的解决结果 → 继续撤回', '先解决冲突并 add，再继续生成用于撤回的提交；它不会替你 add，也不会 push。本练习一次撤回一个普通提交。', 'revert'],
    [/^git revert [^-]/, '应用反向改动 → 创建撤回提交', '默认以新提交抵消目标提交的改动，原提交仍在历史中，无需再单独 commit。冲突会暂停；先编辑并 add，再 revert --continue。它与 reset 移动分支指针的用途不同。', 'revert'],
    [/^git rm (?!-)/, '删除文件 → 暂存删除', '同时从工作区和暂存区删除指定跟踪文件；删除改动仍需 commit 保存。存在受保护的未提交内容时可能拒绝。rm --cached 仅取消跟踪、保留工作区文件，不能按同样的步骤理解。', 'rm'],
    [/^git mv\s/, '移动或改名文件 → 更新暂存区路径', '同步更新文件位置和暂存区中的路径变化，之后仍需 commit 保存；它不会自动提交或推送。', 'mv'],
    [/^git clone\s/, '创建本地仓库 → 获取历史 → 检出初始分支', '普通 clone 会配置 origin、获取对象和远程跟踪引用，并建立、检出初始本地分支；远程空仓库或使用 --bare、--no-checkout 等选项时不同。此条仍仅供真实终端参考，网页不会执行。', 'clone'],
    [/^git fetch --prune\b/, 'fetch 获取更新 → 清理过期跟踪引用', '按远程的 refspec 清理已不存在的远程引用；常见配置下清理的是 origin/*，不会删除你自己的本地开发分支。此条仍仅供真实终端参考，网页不会执行。', 'fetch']
  ];

  function mount({ dialog, content, onSelectCommand }) {
    const doc = content.ownerDocument || document;
    const node = (tag, className, text) => {
      const item = doc.createElement(tag);
      if (className) item.className = className;
      if (text !== undefined) item.textContent = text;
      return item;
    };
    const commandButton = (command, selection = '') => {
      const button = node('button', 'command-chip', command);
      button.type = 'button';
      button.addEventListener('click', () => {
        dialog.close();
        onSelectCommand(command, selection);
      });
      return button;
    };
    const attachOperationGuide = (row, command) => {
      const guide = OPERATION_GUIDES.find(([pattern]) => pattern.test(command));
      if (!guide) return;
      const [, steps, description, page] = guide;
      const detail = node('details', 'help-operation');
      const summary = node('summary');
      summary.append(node('span', 'help-operation-badge', '复合操作'), node('span', 'help-operation-steps', steps));
      const note = node('p', '', description);
      const link = node('a', '', 'Git 官方说明');
      link.href = 'https://git-scm.com/docs/git-' + page;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      note.append(doc.createTextNode(' '), link);
      detail.append(summary, note);
      row.classList.add('has-operation-note');
      row.append(detail);
    };

    const titleEl = dialog.querySelector?.('#help-title');
    if (titleEl) titleEl.textContent = 'Git 命令手册与常用流程';
    const intro = [...(dialog.children || [])].find(el => el.tagName?.toUpperCase() === 'P');
    if (intro) intro.textContent = '点击命令示例只会填入输入框，再按 Enter 执行；标为“仅供参考”的条目与含 && 的组合行供真实终端使用。';

    const helpTabs = node('div', 'help-tabs');
    helpTabs.setAttribute('role', 'tablist');
    helpTabs.setAttribute('aria-label', '命令手册分类');
    const helpPanels = new Map();
    const tabDefs = [
      ['templates', '01 常用模板', '占位符语法与可编辑示例'],
      ['workflows', '02 组合流程 (&&)', '真实终端连写与网页分步练习'],
      ['basic', '03 状态 · 提交 · 分支', '日常查看、暂存、分支与引用'],
      ['advanced', '04 合并 · 变基 · 远程', '分支整合、历史撤回与远程同步']
    ];
    const switchHelpTab = activeKey => {
      for (const btn of helpTabs.children) {
        const active = btn.dataset.tab === activeKey;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const [key, panel] of helpPanels) {
        panel.hidden = key !== activeKey;
      }
    };
    for (const [key, label, sub] of tabDefs) {
      const btn = node('button', 'help-tab');
      btn.type = 'button';
      btn.dataset.tab = key;
      btn.setAttribute('role', 'tab');
      btn.append(node('strong', '', label), node('small', '', sub));
      btn.addEventListener('click', () => switchHelpTab(key));
      helpTabs.append(btn);
      const panel = node('div', 'help-panel');
      panel.dataset.tab = key;
      panel.setAttribute('role', 'tabpanel');
      helpPanels.set(key, panel);
    }

    content.append(helpTabs, ...helpPanels.values());
    content.prepend(
      node(
        'p',
        'help-note help-operation-legend',
        '复合操作：一条 Git 命令内完成多个步骤，点击标记可展开前提与说明。箭头是过程概括，具体行为受参数、配置和仓库状态影响；“终端组合”则是用 && 连写多条命令。可搜索“复合”查看所有标注。'
      )
    );

    const groups = [];
    const registerGroup = (element, heading, items) => {
      const group = {
        element,
        entries: items.map(item => {
          const text = normalize(heading + ' ' + item.textContent);
          return { element: item, text, words: text.match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) || [] };
        })
      };
      groups.push(group);
      return element;
    };

    // 01 常用模板
    const templateGroup = node('section', 'help-group help-templates');
    const templateHeader = node('div', 'help-section-bar');
    templateHeader.append(
      node('h3', '', '常用命令模板 · 点击填入可编辑示例'),
      node('p', 'help-note', '<your-branch-name>、<file-path> 和 <message> 都是占位符，需要替换，不要输入尖括号。点击后会选中需要修改的示例内容。')
    );
    const templateGrid = node('div', 'help-template-grid');
    const templateRows = [];
    for (const [template, description, example, selection] of TEMPLATES) {
      const row = node('div', 'help-row help-template-row');
      const button = commandButton(example, selection);
      button.textContent = template;
      button.title = '点击填入示例：' + example;
      row.append(button, node('span', '', description));
      attachOperationGuide(row, template);
      templateGrid.append(row);
      templateRows.push(row);
    }
    const stashNote = node(
      'p',
      'help-note',
      '练习边界：restore 支持明确文件名和 .，冲突中请编辑后 add。stash pop/apply 可指定 stash@{n}，要求已跟踪文件和暂存区干净；不支持 --index。apply 保留记录，pop 成功后移除；drop/clear 只移除记录。stash 使用独立快照保存，不在提交图中新增普通提交；刷新或切换场景会清空。参考：'
    );
    for (const name of ['restore', 'stash', 'show', 'branch', 'remote']) {
      const link = node('a', '', 'Git ' + name + ' ');
      link.href = 'https://git-scm.com/docs/git-' + name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      stashNote.append(link);
    }
    templateGroup.append(templateHeader, templateGrid, stashNote);
    helpPanels.get('templates').append(registerGroup(templateGroup, '常用命令模板 · 点击填入可编辑示例', templateRows));

    // 02 组合流程 (&&)
    const flowGroup = node('section', 'help-group help-workflows');
    const flowTopBar = node('div', 'help-workflow-topbar');
    flowTopBar.append(
      node('h3', '', '常用组合流程 · 真实终端整行执行'),
      node(
        'p',
        'help-note help-terminal-note',
        '&& 在 PowerShell 7、Git Bash 等终端中表示：前一步成功才执行下一步。失败后会停止后续命令，已成功的步骤不会自动撤销。网页暂不支持 &&，请依次点击下面的分步命令，逐条执行。'
      )
    );
    const sources = node('p', 'help-note help-sources', '参考文档：');
    for (const [title, url] of [
      ['Git switch', 'https://git-scm.com/docs/git-switch'],
      ['Git commit', 'https://git-scm.com/docs/git-commit'],
      ['Git push', 'https://git-scm.com/docs/git-push'],
      ['PowerShell &&', 'https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_pipeline_chain_operators']
    ]) {
      const link = node('a', '', title);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      sources.append(link);
    }
    flowTopBar.append(sources);
    const flowGrid = node('div', 'help-workflow-grid');
    const flowCards = [];
    for (const [title, chain, description, steps] of WORKFLOWS) {
      const card = node('article', 'help-flow');
      const code = node('pre', 'help-chain', chain);
      const actions = node('div', 'help-flow-steps');
      const heading = node('h4', '', title);
      if (chain.includes('&&')) {
        heading.prepend(node('span', 'help-operation-badge is-chain', '终端组合'), doc.createTextNode(' '));
      }
      card.append(heading, code, node('p', 'help-note', description), node('div', 'help-step-label', '网页分步练习 · 按顺序点击填入，再按 Enter 执行'));
      steps.forEach(([command, selection], i) => {
        const button = commandButton(command, selection);
        button.textContent = i + 1 + ' · ' + command;
        actions.append(button);
      });
      card.append(actions);
      flowGrid.append(card);
      flowCards.push(card);
    }
    flowGroup.append(flowTopBar, flowGrid);
    helpPanels.get('workflows').append(registerGroup(flowGroup, '常用组合流程 · 真实终端整行执行', flowCards));

    // 03 & 04 Bento 分类卡片
    const buildGroup = ([title, rows]) => {
      const group = node('section', 'help-group help-card');
      group.append(node('h3', '', title));
      const rowNodes = [];
      for (const [command, description] of rows) {
        const row = node('div', 'help-row');
        row.append(commandButton(command), node('span', '', description));
        attachOperationGuide(row, command);
        group.append(row);
        rowNodes.push(row);
      }
      return registerGroup(group, title, rowNodes);
    };

    const basicGroups = MANUAL.slice(0, 4).map(buildGroup);
    const basicGrid = node('div', 'help-bento-grid');
    const basicCol1 = node('div', 'help-bento-col');
    basicCol1.append(basicGroups[0], basicGroups[1]);
    const basicCol2 = node('div', 'help-bento-col');
    basicCol2.append(basicGroups[2]);
    const basicCol3 = node('div', 'help-bento-col');
    basicCol3.append(basicGroups[3]);
    basicGrid.append(basicCol1, basicCol2, basicCol3);
    helpPanels.get('basic').append(basicGrid);

    const advGroups = MANUAL.slice(4).map(buildGroup);
    const advGrid = node('div', 'help-bento-grid');
    const advCol1 = node('div', 'help-bento-col');
    advCol1.append(advGroups[0], advGroups[1]);
    const advCol2 = node('div', 'help-bento-col');
    advCol2.append(advGroups[2]);
    const advCol3 = node('div', 'help-bento-col');
    advCol3.append(advGroups[3]);
    advGrid.append(advCol1, advCol2, advCol3);
    helpPanels.get('advanced').append(advGrid);

    switchHelpTab('templates');

    const dailyGroup = node('section', 'help-group help-card');
    dailyGroup.append(node('h3', '', '摘取提交与更多日常操作'));
    const dailyRows = [];
    for (const [command, description] of DAILY_COMMANDS) {
      const row = node('div', 'help-row');
      row.append(commandButton(command), node('span', '', description));
      attachOperationGuide(row, command);
      dailyGroup.append(row);
      dailyRows.push(row);
    }
    registerGroup(dailyGroup, '摘取提交与更多日常操作', dailyRows);

    const comparison = node('section', 'help-group help-card');
    const comparisonNote = node(
      'p',
      'help-note help-row',
      '切换分支：git checkout main 与 git switch main 对应；创建并切换：git checkout -b feature 与 git switch -c feature 对应。switch 专门管理分支切换，restore 专门恢复文件。checkout 兼有这两类用途；不能把所有 checkout 都直接替换成 switch。'
    );
    comparison.append(node('h3', '', 'checkout、switch、restore 怎么选？'), comparisonNote);
    registerGroup(comparison, 'checkout、switch、restore 怎么选？', [comparisonNote]);

    const reference = node('section', 'help-group help-card');
    reference.append(
      node('h3', '', '真实终端常用命令 · 仅供参考'),
      node('p', 'help-note', '以下写法依赖真实磁盘、网络、账号或更复杂的 Git 功能，网页不会执行。复制到自己的终端前替换占位符并核对目标；不会连接或修改你的真实仓库。')
    );
    const referenceRows = [];
    for (const [command, description, page] of EXTERNAL_COMMANDS) {
      const row = node('div', 'help-row help-reference-row');
      const code = node('code', 'command-chip', command);
      const detail = node('span', '', '仅供参考 · ' + description);
      const link = node('a', '', '官方说明');
      link.href = 'https://git-scm.com/docs/' + page;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      detail.append(doc.createTextNode(' '), link);
      row.append(code, detail);
      attachOperationGuide(row, command);
      reference.append(row);
      referenceRows.push(row);
    }
    registerGroup(reference, '真实终端常用命令 · 仅供参考', referenceRows);

    const extraGrid = node('div', 'help-bento-grid help-expanded-grid');
    extraGrid.append(dailyGroup, comparison, reference);
    helpPanels.get('advanced').append(extraGrid);

    const containers = [
      { element: helpPanels.get('templates'), groups: [templateGroup] },
      { element: helpPanels.get('workflows'), groups: [flowGroup] },
      { element: helpPanels.get('basic'), groups: basicGroups },
      { element: helpPanels.get('advanced'), groups: [...advGroups, dailyGroup, comparison, reference] },
      { element: basicGrid, groups: basicGroups },
      { element: advGrid, groups: advGroups },
      { element: extraGrid, groups: [dailyGroup, comparison, reference] },
      { element: basicCol1, groups: [basicGroups[0], basicGroups[1]] },
      { element: basicCol2, groups: [basicGroups[2]] },
      { element: basicCol3, groups: [basicGroups[3]] },
      { element: advCol1, groups: [advGroups[0], advGroups[1]] },
      { element: advCol2, groups: [advGroups[2]] },
      { element: advCol3, groups: [advGroups[3]] }
    ];
    const tabs = [helpTabs];
    let saved = null;

    const bar = node('div', 'help-search');
    const label = doc.createElement('label');
    label.htmlFor = 'help-search-input';
    label.textContent = '搜索手册';
    const controls = node('div', 'help-search-controls');
    const input = doc.createElement('input');
    input.id = 'help-search-input';
    input.type = 'search';
    input.autofocus = true;
    input.autocomplete = 'off';
    input.maxLength = 160;
    input.placeholder = '模糊搜索命令或中文说明，如 rbase、取消暂存';
    input.setAttribute('aria-controls', 'help-content');
    input.setAttribute('aria-describedby', 'help-search-status');
    const clear = node('button', 'button quiet small', '清空');
    clear.type = 'button';
    const status = node('p', 'help-search-status');
    status.id = 'help-search-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    controls.append(input, clear);
    bar.append(label, controls, status);
    content.before(bar);

    /** 搜索覆盖全部分类；退出搜索时恢复原来的分类、可见性和滚动位置。 */
    function filter() {
      const terms = normalize(input.value).split(' ').filter(Boolean);
      clear.disabled = input.value.length === 0;
      if (!terms.length) {
        if (saved) {
          for (const [element, hidden] of saved.visibility) element.hidden = hidden;
          dialog.classList.remove('help-search-active');
          dialog.scrollTop = saved.scrollTop;
          saved = null;
        }
        status.textContent = '支持命令片段、漏字母与错字模糊匹配；多个关键词用空格分隔。';
        return;
      }
      if (!saved) {
        const elements = [
          ...tabs,
          ...containers.map(c => c.element),
          ...groups.flatMap(group => [group.element, ...group.entries.map(entry => entry.element)])
        ];
        saved = {
          visibility: new Map(elements.map(element => [element, element.hidden])),
          scrollTop: dialog.scrollTop
        };
        dialog.classList.add('help-search-active');
      }
      let count = 0;
      for (const group of groups) {
        let matches = 0;
        for (const entry of group.entries) {
          const match = terms.every(term => entry.text.includes(term) || entry.words.some(word => fuzzyWord(term, word)));
          entry.element.hidden = !match;
          if (match) matches++;
        }
        group.element.hidden = matches === 0;
        count += matches;
      }
      for (const container of containers) {
        container.element.hidden = !container.groups.some(group => !group.hidden);
      }
      for (const element of tabs) element.hidden = true;
      status.textContent = count
        ? '找到 ' + count + ' 条相关命令与流程 · 全部分类 · 模糊匹配'
        : '没有找到匹配内容，试试命令片段或更短的中文关键词。';
    }

    input.addEventListener('input', filter);
    clear.addEventListener('click', () => {
      input.value = '';
      filter();
      input.focus();
    });
    input.addEventListener('keydown', event => {
      // 输入法选字期间不拦截 Esc；有搜索词时先清空，再次 Esc 交给原生弹窗关闭。
      if (event.key === 'Escape' && input.value && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        event.stopPropagation();
        input.value = '';
        filter();
      }
    });
    filter();

    return { switchTab: switchHelpTab, filter, input, clear, status, tabs: helpTabs, panels: helpPanels };
  }

  const api = { normalize, fuzzyWord, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitHelpManual = api;
})(globalThis);
