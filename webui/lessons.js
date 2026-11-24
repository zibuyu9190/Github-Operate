/* 参考答案与验收只读取虚拟仓库；不会代替用户执行命令或改写文件。 */
(function (root) {
  'use strict';

  const { hasConflictMarkers } =
    typeof module !== 'undefined' && module.exports ? require('./simulator.js') : root.GitSimulator;
  const clone = value => JSON.parse(JSON.stringify(value));
  const headId = state => (state.head.branch ? state.branches[state.head.branch] : state.head.id);
  const treeAt = (state, id) => state.commits[id]?.tree || {};
  const same = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => a[key] === b[key]);
  const command = (text, actor = 'local') => ({ command: text, actor });
  const edit = (instruction, content, options = {}) => ({
    instruction,
    content,
    file: options.file || 'hello.txt',
    append: Boolean(options.append),
    actor: options.actor || 'local'
  });

  const greeting = '你好，Git！\n这是一段问候。\n保留这一行作为共同上下文。\n学习从一次提交开始。\n';
  const resolvedGreeting = greeting.replace('你好，Git！', '你好，主分支与修复分支！');
  const collabGreeting = greeting.replace('你好，Git！', '你好，协作者版本！');
  const localGreeting = greeting.replace('你好，Git！', '你好，本地版本！');
  const mergedCollabGreeting = greeting.replace('你好，Git！', '你好，本地与协作者共同版本！');

  const LESSONS = {
    basic: {
      goal: '修改 hello.txt，并在 main 上创建一次包含这次修改的提交，最后保持工作区与暂存区干净。',
      routes: [
        {
          id: 'commit',
          title: '修改 → 暂存 → 提交',
          expected: 'main 和 HEAD 前进到新提交；三个区域内容一致。提交说明可以自行填写。',
          steps: [
            edit('在文件区选择 hello.txt，增加下面一行并保存；也可以写自己的内容。', '这是我完成的第一次提交。', {
              file: 'hello.txt',
              append: true
            }),
            command('git diff'),
            command('git add hello.txt'),
            command('git diff --cached'),
            command('git commit -m "完成第一次练习"'),
            command('git status')
          ]
        }
      ]
    },
    branches: {
      goal: '把 bugFix 的问候修复与 main 的使用说明整合到 main。可分别用 merge 与 rebase 比较提交图。',
      routes: [
        {
          id: 'merge',
          title: '方案一：merge 汇合',
          expected: 'main 指向一个双亲合并提交，原来两条分支的提交仍保留。合并后可以删除 bugFix。',
          steps: [
            command('git switch main'),
            command('git merge bugFix'),
            command('git log --oneline --graph --all'),
            command('git status')
          ]
        },
        {
          id: 'rebase',
          title: '方案二：rebase 后快进 main',
          expected: 'bugFix 的修复重放到 main 后，产生新 ID；main 快进到该提交后，可以删除 bugFix。',
          steps: [
            command('git switch bugFix'),
            command('git rebase main'),
            command('git switch main'),
            command('git merge bugFix'),
            command('git log --oneline --graph --all'),
            command('git status')
          ]
        }
      ]
    },
    conflict: {
      goal: '触发 main 与 bugFix 的问候语冲突，手动解决后完成合并。',
      note: '最终文字可保留任一方或整合双方，不必与示例相同。自动验收检查冲突标记和提交关系，业务文字需要你自行判断。若要放弃，git merge --abort 会恢复起点，但不算完成练习。',
      routes: [
        {
          id: 'resolve',
          title: '编辑冲突 → add → 继续合并',
          expected: '冲突区消失，main 指向双亲提交，工作区干净，文件中没有冲突标记。',
          steps: [
            command('git merge bugFix'),
            edit('命令出现 CONFLICT 是正常的。把 hello.txt 中的冲突内容改成你认可的结果，删除所有冲突标记并保存；下面是完整参考内容。', resolvedGreeting),
            command('git add hello.txt'),
            command('git merge --continue'),
            command('git status')
          ]
        }
      ]
    },
    rebase: {
      goal: '将当前 bugFix 的修复提交重放到 main 之上，保留修复与主分支的文件修改。',
      note: '预置场景通常不冲突。如果自己编辑后遇到冲突，先编辑保存并 add，再 git rebase --continue；git rebase --abort 用于恢复起点。',
      routes: [
        {
          id: 'replay',
          title: 'bugFix 变基到 main',
          expected: 'HEAD 仍在 bugFix；修复提交获得新 ID、父提交接到 main，main 标签保持不动。旧提交可在图中淡化显示。',
          steps: [command('git rebase main'), command('git log --oneline --graph --all'), command('git status')]
        }
      ]
    },
    reset: {
      goal: '从第三版退回上一提交，比较 soft、mixed、hard 对 HEAD、暂存区与工作区的不同影响。',
      note: '三个方案分别从初始状态开始。换模式前点击页面右上角“重置场景”，再执行对应命令；只切换参考方案不会重置仓库。soft / mixed 练习完成时有待提交改动是正确结果。',
      routes: [
        {
          id: 'soft',
          title: '--soft：保留暂存区和工作区',
          expected: 'HEAD 回到第二版；暂存区、工作区仍是第三版，第三版改动显示为已暂存。',
          steps: [command('git reset --soft HEAD~1'), command('git status'), command('git diff --cached')]
        },
        {
          id: 'mixed',
          title: '--mixed：只保留工作区',
          expected: 'HEAD、暂存区回到第二版；工作区仍是第三版，第三版改动显示为未暂存。',
          steps: [command('git reset --mixed HEAD~1'), command('git status'), command('git diff')]
        },
        {
          id: 'hard',
          title: '--hard：三个区域一起回退',
          expected: 'HEAD、暂存区、工作区均为第二版，工作区干净，第三版内容从文件中移除。',
          steps: [command('git reset --hard HEAD~1'), command('git status')]
        }
      ]
    },
    remote: {
      goal: '把远程协作者的 team.txt 与本地 notes.txt 整合后推送，让 main、origin/main 和远程实际 main 一致。',
      note: '起点的 push 被拒绝是预期结果，不代表做错。fetch 只下载更新；pull 整合到本地；push 才把整合后的提交上传。',
      routes: [
        {
          id: 'merge',
          title: '方案一：pull 合并后推送',
          expected: '合并提交包含本地与远程两条历史；最终三个 main 引用指向同一提交。',
          steps: [
            command('git push'),
            command('git fetch origin'),
            command('git pull --no-rebase origin main'),
            command('git push'),
            command('git status')
          ]
        },
        {
          id: 'rebase',
          title: '方案二：pull 变基后推送',
          expected: '本地记录重放到远程提交之后，形成线性历史；最终三个 main 引用指向同一提交。',
          steps: [
            command('git push'),
            command('git fetch origin'),
            command('git pull --rebase origin main'),
            command('git push'),
            command('git status')
          ]
        }
      ]
    },
    stash: {
      goal: '在 feature 临时保存已暂存、未暂存和未跟踪文件后切回 main 修复并 --amend，或用 restore 清理暂存与工作区改动。',
      note: '两个方案分别从初始状态开始，比较前请先点击“重置场景”。方案一演示 stash -u 与 amend 修订；方案二演示 restore 区分暂存区和工作区。',
      routes: [
        {
          id: 'stash-amend',
          title: '方案一：stash -u 暂存 → main 修复与 amend → 恢复提交',
          expected: 'main 增加经过 amend 修订的修复提交（图中可见被替换的旧提交）；feature 恢复并提交了全部开发改动，工作区干净。',
          steps: [
            command('git stash push -u -m "开发中的草稿"'),
            command('git switch main'),
            edit('选择 README.md，追加下面修复说明并保存（不会带入 feature 已 stash 的改动）。', '## 紧急修复\n\n已修复线上配置说明。\n', {
              file: 'README.md',
              append: true
            }),
            command('git add README.md'),
            command('git commit -m "紧急修复"'),
            command('git commit --amend -m "紧急修复：补充发布说明"'),
            command('git switch feature'),
            command('git stash pop'),
            command('git add .'),
            command('git commit -m "完成 feature 开发"'),
            command('git status')
          ]
        },
        {
          id: 'restore',
          title: '方案二：restore 取消暂存并丢弃未暂存修改',
          expected: 'notes.txt 退出暂存区但保留工作区内容，hello.txt 恢复为提交版本，未跟踪的 draft.txt 保留，且未新建提交。',
          steps: [
            command('git status'),
            command('git restore --staged notes.txt'),
            command('git restore hello.txt'),
            command('git status')
          ]
        }
      ]
    },
    rescue: {
      goal: '练习用 cherry-pick 精准摘取跨分支修复并打 tag，或用 revert 撤回提交并在误 reset --hard 后通过 reflog 救回。',
      note: '两个方案各自独立，切换方案前请先“重置场景”。注意 reflog 的 HEAD@{n} 编号会随新移动命令递增，请先执行 git reflog 核对目标编号。',
      routes: [
        {
          id: 'cherry-pick',
          title: '方案一：cherry-pick 精准摘取修复并打标签',
          expected: 'main 只合入 experiment 最新提交中的 hello.txt 修复，不含半成品 wip.txt，且创建了新的本地标签。',
          steps: [
            command('git show experiment'),
            command('git cherry-pick experiment'),
            command('git tag v1.1'),
            command('git status')
          ]
        },
        {
          id: 'revert-reflog',
          title: '方案二：revert 安全撤回 + reflog 救援误 reset',
          expected: '先用 revert 生成移除 notes.txt 的反向提交，再演示误 reset --hard 后通过 reflog 建立救援分支并恢复 main。',
          steps: [
            command('git revert HEAD'),
            command('git reset --hard HEAD~2'),
            command('git reflog'),
            command('git branch rescue HEAD@{1}'),
            command('git reset --hard rescue'),
            command('git status')
          ]
        }
      ]
    },
    collab: {
      goal: '分别在“模拟协作者”和“我的本地”两个独立仓库修改 hello.txt 的同一行并提交推送，演练非快进拒绝、拉取冲突解决与同步。',
      note: '点击步骤命令会自动切换终端与文件区对应的操作身份；协作者未 push 的提交不会提前出现在“我的本地”。',
      routes: [
        {
          id: 'collab-conflict',
          title: '协作者先推 → 本地并行修改 → pull 解决冲突再推送',
          expected: '双方均以独立提交演进，我的本地触发冲突并清除标记完成整合，最终本地 main、origin/main 与共享远程一致。',
          steps: [
            edit('切换到“模拟协作者”，修改 hello.txt 第一行并保存（也可点击协作者区域下方按钮提交）。', collabGreeting, {
              file: 'hello.txt',
              actor: 'remote'
            }),
            command('git add hello.txt', 'remote'),
            command('git commit -m "协作者更新问候语"', 'remote'),
            command('git push', 'remote'),
            edit('切回“我的本地”，修改 hello.txt 第一行并保存（与协作者改动同一行）。', localGreeting, {
              file: 'hello.txt',
              actor: 'local'
            }),
            command('git add hello.txt', 'local'),
            command('git commit -m "本地更新问候语"', 'local'),
            command('git push', 'local'),
            command('git fetch origin', 'local'),
            command('git pull --no-rebase origin main', 'local'),
            edit('解决冲突：编辑 hello.txt 删除全部冲突标记，整合或保留双方内容并保存。', mergedCollabGreeting, {
              file: 'hello.txt',
              actor: 'local'
            }),
            command('git add hello.txt', 'local'),
            command('git merge --continue', 'local'),
            command('git push', 'local'),
            command('git status', 'local')
          ]
        }
      ]
    }
  };

  function ancestors(state, tip) {
    const seen = new Set();
    const stack = [tip];
    while (stack.length) {
      const id = stack.pop();
      if (!id || seen.has(id) || !state.commits[id]) continue;
      seen.add(id);
      stack.push(...state.commits[id].parents);
    }
    return seen;
  }

  /** 只接受目标之上的普通提交链，防止把 merge 或丢弃修复误判成 rebase。 */
  function replayedOnto(state, tip, onto, original) {
    const seen = new Set();
    let id = tip;
    while (id && id !== onto) {
      const commit = state.commits[id];
      if (!commit || commit.parents.length !== 1 || id === original || seen.has(id)) return false;
      seen.add(id);
      id = commit.parents[0];
    }
    return id === onto && seen.size > 0;
  }

  /** 每次重置重新绑定基线；验收依赖文件与拓扑，不依赖固定 C 编号或提交说明。 */
  class Practice {
    constructor(scene, baseline, route) {
      if (!LESSONS[scene]) throw new Error('未知练习场景。');
      this.scene = scene;
      this.baseline = clone(baseline);
      this.sawConflict = false;
      this.resetEvidence = null;
      this.replayedFeature = null;
      this.evidence = {};
      this.route = LESSONS[scene].routes.some(item => item.id === route) ? route : LESSONS[scene].routes[0].id;
    }

    /** 验收中的操作证据只取有效执行结果，失败命令与图形重播都不能推进进度。 */
    record(result) {
      if (!result || !result.command) return;
      // 现有验收记录的是本地和协作者的操作，第三方整合不能代替这两方的练习。
      if (result.actor === 'integrator') return;
      if (result.actor === 'remote') {
        if (
          result.ok &&
          this.scene === 'collab' &&
          result.command.name === 'push' &&
          result.branch === 'main' &&
          result.after.remote.branches.main !== this.baseline.remote.branches.main
        ) {
          this.evidence.peerPushedId = result.after.remote.branches.main;
        }
        return;
      }
      if (!result.ok) return;
      const command = result.command;
      const revertedId = this.evidence.revertedId;
      if (command.name === 'merge' && result.conflict) this.sawConflict = true;
      if (command.name === 'reset') {
        this.resetEvidence = { mode: command.mode, target: headId(result.after) };
        // 只记录 main 由包含反向提交变为不包含它的那次硬重置。
        if (
          this.scene === 'rescue' &&
          command.mode === 'hard' &&
          result.before.head.branch === 'main' &&
          revertedId &&
          ancestors(result.before, result.before.branches.main).has(revertedId) &&
          !ancestors(result.after, result.after.branches.main).has(revertedId)
        ) {
          this.evidence.droppedReverted = true;
        }
      }
      // 分支清理后仍可用实际完成的变基提交验证快进路线。
      if (this.scene === 'branches' && command.name === 'rebase' && !result.after.pending) {
        const source = result.before.branches.bugFix;
        const tip = result.after.branches.bugFix;
        const branch = result.before.pending?.branch || result.before.head.branch;
        if (branch === 'bugFix' && source === this.baseline.branches.bugFix && tip !== source) {
          this.replayedFeature = tip;
        }
      }
      if (command.name === 'stash') {
        if (command.action === 'push' && result.after.stashes.length > result.before.stashes.length) {
          this.evidence.stashed = true;
        }
        if (['pop', 'apply'].includes(command.action) && !result.conflict) {
          this.evidence.poppedStash = true;
        }
      }
      if (command.name === 'commit' && command.amend && result.after.head.branch === 'main') {
        this.evidence.amendedOnMain = true;
        const resolved = this.evidence.resolvedCollab;
        if (this.scene === 'collab' && resolved?.id === headId(result.before)) {
          const amendedId = headId(result.after);
          const validAmend =
            ancestors(result.after, amendedId).has(resolved.peerId) &&
            (resolved.mode === 'merge'
              ? result.after.commits[amendedId]?.parents.length === 2 && ancestors(result.after, amendedId).has(resolved.localTip)
              : amendedId !== resolved.peerId);
          if (validAmend) resolved.id = amendedId;
        }
      }
      if (
        command.name === 'cherry-pick' &&
        command.action !== 'abort' &&
        !result.after.pending &&
        Object.keys(result.after.commits).length > Object.keys(result.before.commits).length
      ) {
        this.evidence.cherryPicked = true;
      }
      if (
        this.scene === 'rescue' &&
        command.name === 'revert' &&
        command.action !== 'abort' &&
        !result.after.pending &&
        result.after.head.branch === 'main'
      ) {
        this.evidence.revertedId = headId(result.after);
        this.evidence.droppedReverted = false;
        this.evidence.usedReflogAfterDrop = false;
        this.evidence.rescuedBranches = new Set();
      }
      if (
        command.name === 'reflog' &&
        this.evidence.droppedReverted &&
        !ancestors(result.after, result.after.branches.main).has(revertedId)
      ) {
        this.evidence.usedReflogAfterDrop = true;
      }
      const mayCreateBranch =
        (command.name === 'branch' && command.action === 'create') || ['switch', 'checkout'].includes(command.name);
      // 救援分支必须在查阅 reflog 后、main 恢复前创建。
      if (
        mayCreateBranch &&
        this.evidence.usedReflogAfterDrop &&
        !ancestors(result.after, result.after.branches.main).has(revertedId)
      ) {
        for (const [name, tip] of Object.entries(result.after.branches)) {
          if (
            !Object.hasOwn(result.before.branches, name) &&
            !Object.hasOwn(this.baseline.branches, name) &&
            tip === revertedId
          ) {
            this.evidence.rescuedBranches.add(name);
          }
        }
      }
      if (command.name === 'branch' && command.action === 'rename') {
        const previousName = command.branch || result.before.head.branch;
        if (this.evidence.rescuedBranches?.delete(previousName)) this.evidence.rescuedBranches.add(command.target);
      }
      if (this.scene === 'collab' && ['pull', 'merge', 'rebase'].includes(command.name) && result.conflict) {
        const peerId = this.evidence.peerPushedId;
        const localTip = result.before.branches.main;
        const pending = result.after.pending;
        const mergeConflictValid =
          pending?.type === 'merge' &&
          ancestors(result.after, pending.other).has(peerId) &&
          !ancestors(result.after, pending.other).has(localTip);
        const rebaseConflictValid =
          pending?.type === 'rebase' &&
          ancestors(result.after, headId(result.after)).has(peerId) &&
          !ancestors(result.after, headId(result.after)).has(localTip);
        if (peerId && localTip && localTip !== this.baseline.branches.main && (mergeConflictValid || rebaseConflictValid)) {
          this.evidence.localPulledConflict = true;
          this.evidence.collabConflict = { type: pending.type, peerId, localTip };
        }
      }
      if (this.scene === 'collab' && result.before.pending && !result.after.pending && command.action !== 'abort') {
        const conflict = this.evidence.collabConflict;
        if (result.before.pending.type === 'merge' && conflict?.type === 'merge') {
          const resolvedId = headId(result.after);
          if (
            result.after.commits[resolvedId]?.parents.length === 2 &&
            ancestors(result.after, resolvedId).has(conflict.peerId) &&
            ancestors(result.after, resolvedId).has(conflict.localTip)
          ) {
            this.evidence.resolvedCollab = { id: resolvedId, mode: 'merge', peerId: conflict.peerId, localTip: conflict.localTip };
          }
        } else if (result.before.pending.type === 'rebase' && conflict?.type === 'rebase') {
          const resolvedId = result.after.branches.main;
          if (resolvedId && resolvedId !== conflict.peerId && ancestors(result.after, resolvedId).has(conflict.peerId)) {
            this.evidence.resolvedCollab = { id: resolvedId, mode: 'rebase', peerId: conflict.peerId, localTip: conflict.localTip };
          }
        }
      }
    }

    evaluate(state, dirty = false) {
      const baseline = this.baseline;
      const checks = [];
      const add = (label, passed, pending) => checks.push({ label, passed: Boolean(passed), detail: passed ? '已通过' : pending });
      const id = headId(state);
      const head = treeAt(state, id);
      const initial = treeAt(baseline, headId(baseline));
      const current = state.commits[id];
      const main = state.branches.main;
      const feature = state.branches.bugFix;
      const oldMain = baseline.branches.main;
      const oldFeature = baseline.branches.bugFix;
      const clean = same(head, state.index) && same(state.index, state.work) && !dirty && !state.pending;
      const mainTree = treeAt(state, main);
      const expectedFiles =
        mainTree['hello.txt'] === treeAt(baseline, oldFeature)['hello.txt'] &&
        mainTree['README.md'] === treeAt(baseline, oldMain)['README.md'] &&
        mainTree['notes.txt'] === treeAt(baseline, oldMain)['notes.txt'];
      const hasMerge = tip => [...ancestors(state, tip)].some(commit => !baseline.commits[commit] && state.commits[commit].parents.length === 2);

      if (this.scene === 'basic') {
        add(
          'main 上已有新的普通提交',
          state.head.branch === 'main' && id !== headId(baseline) && current?.parents.length === 1 && ancestors(state, id).has(headId(baseline)),
          '编辑文件后 add，并在 main 上 commit。'
        );
        add(
          'hello.txt 的修改已进入当前提交',
          typeof head['hello.txt'] === 'string' && head['hello.txt'] !== initial['hello.txt'],
          '只编辑或 add 还未提交；请检查 HEAD 中的 hello.txt。'
        );
        add('三个区域一致，工作区干净', clean, dirty ? '编辑器还有未保存草稿。' : '还有未暂存或未提交的改动。');
      } else if (this.scene === 'branches') {
        if (this.route === 'merge') {
          add(
            'main 汇合原来的两条历史',
            hasMerge(main) && ancestors(state, main).has(oldMain) && ancestors(state, main).has(oldFeature),
            '在 main 上执行 git merge bugFix，形成双亲提交。'
          );
          add(
            'bugFix 保持原位或已清理',
            feature === oldFeature || (!feature && ancestors(state, main).has(oldFeature)),
            '本方案合并原 bugFix 的历史，合并后可以删除该分支。'
          );
        } else {
          const replayed = feature ?? this.replayedFeature;
          add('bugFix 已重放到原 main 之上', replayedOnto(state, replayed, oldMain, oldFeature), '先切换 bugFix，再执行 git rebase main。');
          add('main 已快进到变基后的提交', main === replayed && main !== oldMain, '切回 main，执行 git merge bugFix 完成快进。');
        }
        add('main 保留问候修复与使用说明', expectedFiles, '检查 main 中 hello.txt、README.md 和 notes.txt。');
        add('回到 main，工作区干净', state.head.branch === 'main' && clean, '切回 main，并处理尚未提交的改动。');
      } else if (this.scene === 'conflict') {
        const merged = hasMerge(main) && ancestors(state, main).has(oldMain) && ancestors(state, main).has(oldFeature);
        const ready = (state.pending?.type === 'merge' && state.pending.unresolved.length === 0) || merged;
        add('已经触发本关合并冲突', this.sawConflict, '从本场景起点执行 git merge bugFix。');
        add(
          '冲突标记清除，解决结果已暂存',
          this.sawConflict &&
            ready &&
            typeof state.work['hello.txt'] === 'string' &&
            !hasConflictMarkers(state.work['hello.txt']) &&
            same(state.index, state.work) &&
            !dirty,
          '编辑 hello.txt，删除冲突标记，保存后 git add hello.txt。'
        );
        add(
          'main 已创建双亲合并提交',
          state.head.branch === 'main' && merged && !state.pending,
          '所有冲突暂存后执行 git merge --continue，或 git commit -m "说明"。'
        );
        add('合并完成，工作区干净', merged && clean && !Object.values(head).some(hasConflictMarkers), '完成合并并检查文件中是否仍有冲突标记。');
      } else if (this.scene === 'rebase') {
        const featureTree = treeAt(state, feature);
        add('bugFix 新提交接在原 main 后面', replayedOnto(state, feature, oldMain, oldFeature), '执行 git rebase main；使用 merge 或 reset 不能完成本关目标。');
        add(
          '保留修复与 main 的使用说明',
          featureTree['hello.txt'] === treeAt(baseline, oldFeature)['hello.txt'] &&
            featureTree['README.md'] === treeAt(baseline, oldMain)['README.md'],
          '变基后的快照应同时包含两边的文件修改。'
        );
        add('main 标签不移动，HEAD 在 bugFix', main === oldMain && state.head.branch === 'bugFix', '本关只变基 bugFix，不需要移动 main。');
        add('变基结束，工作区干净', clean, '解决进行中的冲突，add 后 rebase --continue。');
      } else if (this.scene === 'reset') {
        const target = baseline.commits[headId(baseline)].parents[0];
        const targetTree = treeAt(baseline, target);
        add(
          '已执行对应模式的 reset',
          this.resetEvidence?.mode === this.route && this.resetEvidence.target === target,
          '先重置场景，再执行 git reset --' + this.route + ' HEAD~1。'
        );
        add('main 与 HEAD 回到上一提交', state.head.branch === 'main' && id === target, '目标是本关初始提交的上一代。');
        add(
          this.route === 'soft' ? '暂存区保留第三版' : '暂存区回到第二版',
          same(state.index, this.route === 'soft' ? initial : targetTree),
          '检查暂存区与所选模式的预期是否一致。'
        );
        add(
          this.route === 'hard' ? '工作区回到第二版' : '工作区保留第三版',
          same(state.work, this.route === 'hard' ? targetTree : initial) && !dirty && !state.pending,
          '检查文件内容；切换模式前需要重置场景。'
        );
      } else if (this.scene === 'remote') {
        const remote = state.remote.branches.main;
        const initialRemote = baseline.remote.branches.main;
        add(
          '远程历史已下载到本地',
          Boolean(state.commits[initialRemote]) && ancestors(state, state.tracking.main).has(initialRemote),
          '执行 git fetch origin，或通过 pull 下载远程历史。'
        );
        const integrated =
          this.route === 'merge'
            ? hasMerge(main) && ancestors(state, main).has(oldMain) && ancestors(state, main).has(initialRemote)
            : replayedOnto(state, main, initialRemote, oldMain);
        add(
          this.route === 'merge' ? '通过合并整合双方历史' : '本地提交重放在远程历史之后',
          integrated &&
            mainTree['notes.txt'] === initial['notes.txt'] &&
            typeof mainTree['team.txt'] === 'string' &&
            mainTree['team.txt'].includes(treeAt({ commits: baseline.remote.commits }, initialRemote)['team.txt']),
          '按所选方案执行 pull，并保留 notes.txt 与 team.txt。'
        );
        add(
          '本地、跟踪引用与远程 main 一致',
          integrated && main === remote && state.tracking.main === remote,
          'pull 之后还需要 git push；fetch 本身不会上传提交。'
        );
        add('HEAD 在 main，工作区干净', state.head.branch === 'main' && clean, '完成整合与推送，并处理剩余文件改动。');
      } else if (this.scene === 'stash') {
        const devBranch = state.branches.feature;
        const oldDev = baseline.branches.feature;
        const devTree = treeAt(state, devBranch);
        const oldDevTree = treeAt(baseline, oldDev);
        if (this.route === 'stash-amend') {
          add(
            '已用 stash 临时保存并恢复改动',
            this.evidence.stashed && this.evidence.poppedStash && state.stashes.length === 0,
            '先在 feature 执行 git stash push -u，切回后用 git stash pop 恢复。'
          );
          add(
            'main 已提交修复并经 --amend 修订',
            this.evidence.amendedOnMain &&
              main !== oldMain &&
              ancestors(state, main).has(oldMain) &&
              mainTree['README.md'] !== treeAt(baseline, oldMain)['README.md'],
            '在 main 上编辑 README.md 提交后，再执行 git commit --amend。'
          );
          add(
            'feature 已提交恢复的全部改动',
            devBranch !== oldDev &&
              ancestors(state, devBranch).has(oldDev) &&
              typeof devTree['draft.txt'] === 'string' &&
              devTree['notes.txt'] !== oldDevTree['notes.txt'] &&
              devTree['hello.txt'] !== oldDevTree['hello.txt'],
            '切回 feature、pop 后执行 git add . 与 git commit。'
          );
          add('位于 feature，工作区干净', state.head.branch === 'feature' && clean, '完成提交并保持工作区干净。');
        } else {
          add('已取消 notes.txt 暂存', same(state.index, head), '执行 git restore --staged notes.txt，使暂存区回到 HEAD。');
          add(
            '保留 notes.txt 工作区改动',
            state.work['notes.txt'] === baseline.work['notes.txt'],
            '只取消暂存，不要使用 stash 或带路径的 restore 覆盖 notes.txt 工作区。'
          );
          add('已丢弃 hello.txt 未暂存修改', state.work['hello.txt'] === head['hello.txt'], '执行 git restore hello.txt 恢复为暂存区快照。');
          add(
            '保留未跟踪 draft.txt 且未新增提交',
            state.head.branch === 'feature' && id === oldDev && state.work['draft.txt'] === baseline.work['draft.txt'] && !dirty && !state.pending,
            '保留 draft.txt 与原 HEAD 位置，保存或处理草稿。'
          );
        }
      } else if (this.scene === 'rescue') {
        const experiment = state.branches.experiment;
        const oldExperiment = baseline.branches.experiment;
        const oldMainTree = treeAt(baseline, oldMain);
        if (this.route === 'cherry-pick') {
          add(
            '已把修复提交摘取到 main',
            this.evidence.cherryPicked &&
              experiment === oldExperiment &&
              main !== oldMain &&
              ancestors(state, main).has(oldMain) &&
              state.commits[main]?.parents.length === 1 &&
              !ancestors(state, main).has(oldExperiment),
            '在 main 上执行 git cherry-pick experiment，不要用 merge。'
          );
          add(
            'main 包含问候修复且不含 wip.txt',
            mainTree['hello.txt'] === treeAt(baseline, oldExperiment)['hello.txt'] &&
              !Object.hasOwn(mainTree, 'wip.txt') &&
              mainTree['notes.txt'] === oldMainTree['notes.txt'],
            '只摘取最后一个修复提交，不要带入 wip.txt。'
          );
          add(
            '已为当前 main 提交创建新标签',
            Object.entries(state.tags || {}).some(([name, tag]) => !Object.hasOwn(baseline.tags || {}, name) && tag.id === main),
            '执行 git tag v1.1 给修复后的版本打标签。'
          );
          add('位于 main，工作区干净', state.head.branch === 'main' && clean, '保持位于 main 且工作区干净。');
        } else {
          const revertedId = this.evidence.revertedId;
          const revertedOk = Boolean(
            revertedId &&
              state.commits[revertedId] &&
              !Object.hasOwn(treeAt(state, revertedId), 'notes.txt') &&
              ancestors(state, revertedId).has(oldMain)
          );
          add('已通过 revert 生成撤回 notes.txt 的反向提交', revertedOk, '在 main 上执行 git revert HEAD。');
          add(
            '已演练误 reset 丢失提交并用 reflog 排查',
            Boolean(this.evidence.droppedReverted && this.evidence.usedReflogAfterDrop),
            '执行 git reset --hard 回退并丢弃该提交，再执行 git reflog 查找旧位置。'
          );
          add(
            '已用新分支救回该反向提交',
            revertedOk &&
              Object.entries(state.branches).some(
                ([name, tip]) => !Object.hasOwn(baseline.branches, name) && tip === revertedId && this.evidence.rescuedBranches?.has(name)
              ),
            '在丢弃提交并排查 reflog 后，执行 git branch rescue HEAD@{n} 救回提交。'
          );
          add(
            'main 已恢复至反向提交，工作区干净',
            revertedOk && Boolean(this.evidence.droppedReverted) && state.head.branch === 'main' && main === revertedId && clean,
            '执行 git reset --hard rescue 恢复 main 并保持工作区干净。'
          );
        }
      } else if (this.scene === 'collab') {
        const remote = state.remote.branches.main;
        const peerId = this.evidence.peerPushedId;
        const remoteHistory = ancestors({ commits: state.remote.commits }, remote);
        const resolved = this.evidence.resolvedCollab;
        const resolvedValid = Boolean(
          resolved &&
            peerId &&
            resolved.peerId === peerId &&
            !state.pending &&
            ancestors(state, main).has(resolved.id) &&
            ancestors(state, resolved.id).has(peerId) &&
            ancestors(state, resolved.id).has(oldMain) &&
            (resolved.mode === 'merge'
              ? state.commits[resolved.id]?.parents.length === 2 && ancestors(state, resolved.id).has(resolved.localTip)
              : resolved.id !== peerId) &&
            !Object.values(mainTree).some(hasConflictMarkers)
        );
        add(
          '协作者已提交并推送新内容到共享远程',
          Boolean(peerId && peerId !== baseline.remote.branches.main && remoteHistory.has(peerId)),
          '切换到“模拟协作者”，修改 hello.txt、add、commit 并 push。'
        );
        add(
          '我的本地已触发并发修改冲突',
          Boolean(this.evidence.localPulledConflict),
          '切回“我的本地”修改 hello.txt 同处并提交，再执行 fetch 与 pull 触发冲突。'
        );
        add('本地 main 已解决冲突并整合双方提交', resolvedValid, '删除冲突标记、git add hello.txt、继续完成整合（不要 abort 丢弃冲突解决）。');
        add('本地、跟踪引用与共享远程 main 一致', Boolean(resolvedValid && main === remote && state.tracking.main === remote), '完成整合后执行 git push 同步到共享远程。');
        add('回到我的本地 main，工作区干净', state.head.branch === 'main' && clean, '在我的本地 main 保持工作区干净。');
      }

      const passed = checks.filter(check => check.passed).length;
      return { checks, passed, total: checks.length, complete: passed === checks.length, dirty };
    }
  }

  /** 原生 details 支持键盘展开；点击参考命令只填入输入框，不执行答案。 */
  class View {
    constructor(anchor, onCommand, onRoute) {
      this.onCommand = onCommand;
      this.onRoute = onRoute;
      this.make = (tag, className, text) => {
        const element = document.createElement(tag);
        element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
      };
      const node = this.make;
      this.root = node('details', 'lesson-guide');
      this.root.id = 'lesson-guide';
      this.summary = node('summary', 'lesson-summary');
      this.badge = node('span', 'lesson-badge');
      this.summary.append(node('strong', '', '参考答案与验收'), this.badge, node('span', 'lesson-toggle', '展开查看步骤'));
      this.body = node('div', 'lesson-body');
      this.goal = node('p', 'lesson-goal');

      const label = node('label', 'lesson-route-label', '参考方案');
      this.select = node('select', 'lesson-route');
      this.select.id = 'lesson-route';
      label.htmlFor = this.select.id;
      this.select.addEventListener('change', () => this.onRoute(this.select.value));
      this.routeBar = node('div', 'lesson-route-bar');
      this.routeBar.append(label, this.select);

      this.notice = node('p', 'lesson-notice', '每个方案从本场景初始状态开始。命令逐条执行，点击只填入；不同方案请先重置场景再比较。');
      this.steps = node('ol', 'lesson-steps');
      this.expected = node('p', 'lesson-expected');
      this.note = node('p', 'lesson-notice');
      this.checks = node('ul', 'lesson-checks');
      this.status = node('p', 'lesson-status');
      this.status.setAttribute('role', 'status');
      this.status.setAttribute('aria-live', 'polite');

      this.body.append(
        this.goal,
        this.routeBar,
        this.notice,
        node('h3', '', '参考步骤'),
        this.steps,
        this.expected,
        this.note,
        node('h3', '', '当前验收结果'),
        this.status,
        this.checks,
        node('p', 'lesson-notice', '验收随当前状态更新；后续编辑可能回到待完成。等效命令也可以达标，提交说明和模拟 ID 不必完全相同。')
      );
      this.root.append(this.summary, this.body);
      anchor.before(this.root);
    }

    update(practice, state, dirty) {
      const lesson = LESSONS[practice.scene];
      const route = lesson.routes.find(item => item.id === practice.route);
      const node = this.make;

      if (this.scene !== practice.scene) {
        this.select.replaceChildren(
          ...lesson.routes.map(item => {
            const option = node('option', '', item.title);
            option.value = item.id;
            return option;
          })
        );
      }

      if (this.scene !== practice.scene || this.route !== practice.route) {
        this.goal.textContent = '本关目标：' + lesson.goal;
        this.select.value = practice.route;
        const hasRemoteActor = route.steps.some(step => step.actor === 'remote');
        this.steps.replaceChildren(
          ...route.steps.map(step => {
            const row = node('li', '');
            if (hasRemoteActor) {
              const remote = step.actor === 'remote';
              row.append(node('span', 'lesson-actor' + (remote ? ' is-remote' : ''), remote ? '模拟协作者' : '我的本地'));
            }
            if (step.command) {
              const button = node('button', 'lesson-command', step.command);
              button.type = 'button';
              button.title = '点击填入，检查后按 Enter 执行';
              button.addEventListener('click', () => this.onCommand(step.command, step.actor || 'local'));
              row.append(button);
            } else {
              row.append(node('span', '', step.instruction), node('pre', 'lesson-sample', step.content));
            }
            return row;
          })
        );
        this.expected.textContent = '预期结果：' + route.expected;
        this.note.textContent = lesson.note || '';
        this.note.hidden = !lesson.note;
        this.body.scrollTop = 0;
        this.scene = practice.scene;
        this.route = practice.route;
      }

      const result = practice.evaluate(state, dirty);
      this.badge.textContent = result.complete ? '本方案已完成 ✓' : '待完成 ' + result.passed + '/' + result.total;
      this.root.classList.toggle('lesson-complete', result.complete);
      const text = result.complete
        ? '本方案已完成，全部验收条件通过。'
        : '已通过 ' + result.passed + '/' + result.total + ' 项。' + (dirty ? '编辑器还有未保存草稿。' : '请对照下方待完成项继续练习。');
      if (this.status.textContent !== text) this.status.textContent = text;

      this.checks.replaceChildren(
        ...result.checks.map(check => {
          const row = node('li', check.passed ? 'passed' : '');
          row.append(
            node('span', 'lesson-check-label', (check.passed ? '✓ 已通过 · ' : '○ 待完成 · ') + check.label),
            node('small', '', check.detail)
          );
          return row;
        })
      );
    }
  }

  const api = { LESSONS, Practice, View };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitLessons = api;
})(globalThis);
