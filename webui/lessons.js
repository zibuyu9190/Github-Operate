/* 参考答案与验收只读取虚拟仓库；不会代替用户执行命令或改写文件。 */
(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const headId = state => state.head.branch ? state.branches[state.head.branch] : state.head.id;
  const treeAt = (state, id) => state.commits[id]?.tree || {};
  const same = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => a[key] === b[key]);
  const markers = text => /^(<<<<<<<(?: |$)|=======$|>>>>>>>(?: |$))/m.test(text || '');
  const command = text => ({ command: text });
  const edit = (instruction, content) => ({ instruction, content });
  const greeting = '你好，Git！\n这是一段问候。\n保留这一行作为共同上下文。\n学习从一次提交开始。\n';
  const resolvedGreeting = greeting.replace('你好，Git！', '你好，主分支与修复分支！');

  const LESSONS = {
    basic: {
      goal: '修改 hello.txt，并在 main 上创建一次包含这次修改的提交，最后保持工作区与暂存区干净。',
      routes: [{ id: 'commit', title: '修改 → 暂存 → 提交', expected: 'main 和 HEAD 前进到新提交；三个区域内容一致。提交说明可以自行填写。', steps: [edit('在文件区选择 hello.txt，增加下面一行并保存；也可以写自己的内容。', '这是我完成的第一次提交。'), command('git diff'), command('git add hello.txt'), command('git diff --cached'), command('git commit -m "完成第一次练习"'), command('git status')] }]
    },
    branches: {
      goal: '把 bugFix 的问候修复与 main 的使用说明整合到 main。可分别用 merge 与 rebase 比较提交图。',
      routes: [
        { id: 'merge', title: '方案一：merge 汇合', expected: 'main 指向一个双亲合并提交，原来两条分支的提交仍保留；bugFix 标签不移动。', steps: [command('git switch main'), command('git merge bugFix'), command('git log --oneline --graph --all'), command('git status')] },
        { id: 'rebase', title: '方案二：rebase 后快进 main', expected: 'bugFix 的修复重放到 main 后，产生新 ID；最后 main 快进到 bugFix，两者指向同一个普通提交。', steps: [command('git switch bugFix'), command('git rebase main'), command('git switch main'), command('git merge bugFix'), command('git log --oneline --graph --all'), command('git status')] }
      ]
    },
    conflict: {
      goal: '触发 main 与 bugFix 的问候语冲突，手动解决后完成合并。',
      note: '最终文字可保留任一方或整合双方，不必与示例相同。自动验收检查冲突标记和提交关系，业务文字需要你自行判断。若要放弃，git merge --abort 会恢复起点，但不算完成练习。',
      routes: [{ id: 'resolve', title: '编辑冲突 → add → 继续合并', expected: '冲突区消失，main 指向双亲提交，工作区干净，文件中没有冲突标记。', steps: [command('git merge bugFix'), edit('命令出现 CONFLICT 是正常的。把 hello.txt 中的冲突内容改成你认可的结果，删除所有冲突标记并保存；下面是完整参考内容。', resolvedGreeting), command('git add hello.txt'), command('git merge --continue'), command('git status')] }]
    },
    rebase: {
      goal: '将当前 bugFix 的修复提交重放到 main 之上，保留修复与主分支的文件修改。',
      note: '预置场景通常不冲突。如果自己编辑后遇到冲突，先编辑保存并 add，再 git rebase --continue；git rebase --abort 用于恢复起点。',
      routes: [{ id: 'replay', title: 'bugFix 变基到 main', expected: 'HEAD 仍在 bugFix；修复提交获得新 ID、父提交接到 main，main 标签保持不动。旧提交可在图中淡化显示。', steps: [command('git rebase main'), command('git log --oneline --graph --all'), command('git status')] }]
    },
    reset: {
      goal: '从第三版退回上一提交，比较 soft、mixed、hard 对 HEAD、暂存区与工作区的不同影响。',
      note: '三个方案分别从初始状态开始。换模式前点击页面右上角“重置场景”，再执行对应命令；只切换参考方案不会重置仓库。soft / mixed 练习完成时有待提交改动是正确结果。',
      routes: [
        { id: 'soft', title: '--soft：保留暂存区和工作区', expected: 'HEAD 回到第二版；暂存区、工作区仍是第三版，第三版改动显示为已暂存。', steps: [command('git reset --soft HEAD~1'), command('git status'), command('git diff --cached')] },
        { id: 'mixed', title: '--mixed：只保留工作区', expected: 'HEAD、暂存区回到第二版；工作区仍是第三版，第三版改动显示为未暂存。', steps: [command('git reset --mixed HEAD~1'), command('git status'), command('git diff')] },
        { id: 'hard', title: '--hard：三个区域一起回退', expected: 'HEAD、暂存区、工作区均为第二版，工作区干净，第三版内容从文件中移除。', steps: [command('git reset --hard HEAD~1'), command('git status')] }
      ]
    },
    remote: {
      goal: '把远程协作者的 team.txt 与本地 notes.txt 整合后推送，让 main、origin/main 和远程实际 main 一致。',
      note: '起点的 push 被拒绝是预期结果，不代表做错。fetch 只下载更新；pull 整合到本地；push 才把整合后的提交上传。',
      routes: [
        { id: 'merge', title: '方案一：pull 合并后推送', expected: '合并提交包含本地与远程两条历史；最终三个 main 引用指向同一提交。', steps: [command('git push'), command('git fetch origin'), command('git pull --no-rebase origin main'), command('git push'), command('git status')] },
        { id: 'rebase', title: '方案二：pull 变基后推送', expected: '本地记录重放到远程提交之后，形成线性历史；最终三个 main 引用指向同一提交。', steps: [command('git push'), command('git fetch origin'), command('git pull --rebase origin main'), command('git push'), command('git status')] }
      ]
    }
  };

  function ancestors(state, tip) {
    const seen = new Set(), stack = [tip];
    while (stack.length) {
      const id = stack.pop();
      if (!id || seen.has(id) || !state.commits[id]) continue;
      seen.add(id); stack.push(...state.commits[id].parents);
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
      seen.add(id); id = commit.parents[0];
    }
    return id === onto && seen.size > 0;
  }

  /** 每次重置重新绑定基线；验收依赖文件与拓扑，不依赖固定 C 编号或提交说明。 */
  class Practice {
    constructor(scene, baseline, route) {
      if (!LESSONS[scene]) throw new Error('未知练习场景。');
      this.scene = scene; this.baseline = clone(baseline); this.sawConflict = false; this.resetEvidence = null;
      this.route = LESSONS[scene].routes.some(item => item.id === route) ? route : LESSONS[scene].routes[0].id;
    }

    /** 验收中的操作证据只取成功结果，失败命令与图形重播都不能推进进度。 */
    record(result) {
      if (!result.ok || !result.command) return;
      if (result.command.name === 'merge' && result.conflict) this.sawConflict = true;
      if (result.command.name === 'reset') this.resetEvidence = { mode: result.command.mode, target: headId(result.after) };
    }

    evaluate(state, dirty = false) {
      const baseline = this.baseline, checks = [];
      const add = (label, passed, pending) => checks.push({ label, passed: Boolean(passed), detail: passed ? '已通过' : pending });
      const id = headId(state), head = treeAt(state, id), initial = treeAt(baseline, headId(baseline));
      const current = state.commits[id], main = state.branches.main, feature = state.branches.bugFix;
      const oldMain = baseline.branches.main, oldFeature = baseline.branches.bugFix;
      const clean = same(head, state.index) && same(state.index, state.work) && !dirty && !state.pending;
      const mainTree = treeAt(state, main);
      const expectedFiles = mainTree['hello.txt'] === treeAt(baseline, oldFeature)['hello.txt'] && mainTree['README.md'] === treeAt(baseline, oldMain)['README.md'] && mainTree['notes.txt'] === treeAt(baseline, oldMain)['notes.txt'];
      const hasMerge = tip => [...ancestors(state, tip)].some(commit => !baseline.commits[commit] && state.commits[commit].parents.length === 2);
      if (this.scene === 'basic') {
        add('main 上已有新的普通提交', state.head.branch === 'main' && id !== headId(baseline) && current?.parents.length === 1 && ancestors(state, id).has(headId(baseline)), '编辑文件后 add，并在 main 上 commit。');
        add('hello.txt 的修改已进入当前提交', typeof head['hello.txt'] === 'string' && head['hello.txt'] !== initial['hello.txt'], '只编辑或 add 还未提交；请检查 HEAD 中的 hello.txt。');
        add('三个区域一致，工作区干净', clean, dirty ? '编辑器还有未保存草稿。' : '还有未暂存或未提交的改动。');
      } else if (this.scene === 'branches') {
        if (this.route === 'merge') {
          add('main 汇合原来的两条历史', hasMerge(main) && ancestors(state, main).has(oldMain) && ancestors(state, main).has(oldFeature), '在 main 上执行 git merge bugFix，形成双亲提交。');
          add('bugFix 标签保持原位', feature === oldFeature, '本方案不需要移动 bugFix；比较其他方案前请重置场景。');
        } else {
          add('bugFix 已重放到原 main 之上', replayedOnto(state, feature, oldMain, oldFeature), '先切换 bugFix，再执行 git rebase main。');
          add('main 已快进到变基后的 bugFix', main === feature && main !== oldMain, '切回 main，执行 git merge bugFix 完成快进。');
        }
        add('main 保留问候修复与使用说明', expectedFiles, '检查 main 中 hello.txt、README.md 和 notes.txt。');
        add('回到 main，工作区干净', state.head.branch === 'main' && clean, '切回 main，并处理尚未提交的改动。');
      } else if (this.scene === 'conflict') {
        const merged = hasMerge(main) && ancestors(state, main).has(oldMain) && ancestors(state, main).has(oldFeature);
        const ready = (state.pending?.type === 'merge' && state.pending.unresolved.length === 0) || merged;
        add('已经触发本关合并冲突', this.sawConflict, '从本场景起点执行 git merge bugFix。');
        add('冲突标记清除，解决结果已暂存', this.sawConflict && ready && typeof state.work['hello.txt'] === 'string' && !markers(state.work['hello.txt']) && same(state.index, state.work) && !dirty, '编辑 hello.txt，删除冲突标记，保存后 git add hello.txt。');
        add('main 已创建双亲合并提交', state.head.branch === 'main' && merged && !state.pending, '所有冲突暂存后执行 git merge --continue，或 git commit -m "说明"。');
        add('合并完成，工作区干净', merged && clean && !Object.values(head).some(markers), '完成合并并检查文件中是否仍有冲突标记。');
      } else if (this.scene === 'rebase') {
        const featureTree = treeAt(state, feature);
        add('bugFix 新提交接在原 main 后面', replayedOnto(state, feature, oldMain, oldFeature), '执行 git rebase main；使用 merge 或 reset 不能完成本关目标。');
        add('保留修复与 main 的使用说明', featureTree['hello.txt'] === treeAt(baseline, oldFeature)['hello.txt'] && featureTree['README.md'] === treeAt(baseline, oldMain)['README.md'], '变基后的快照应同时包含两边的文件修改。');
        add('main 标签不移动，HEAD 在 bugFix', main === oldMain && state.head.branch === 'bugFix', '本关只变基 bugFix，不需要移动 main。');
        add('变基结束，工作区干净', clean, '解决进行中的冲突，add 后 rebase --continue。');
      } else if (this.scene === 'reset') {
        const target = baseline.commits[headId(baseline)].parents[0], targetTree = treeAt(baseline, target);
        add('已执行对应模式的 reset', this.resetEvidence?.mode === this.route && this.resetEvidence.target === target, '先重置场景，再执行 git reset --' + this.route + ' HEAD~1。');
        add('main 与 HEAD 回到上一提交', state.head.branch === 'main' && id === target, '目标是本关初始提交的上一代。');
        add(this.route === 'soft' ? '暂存区保留第三版' : '暂存区回到第二版', same(state.index, this.route === 'soft' ? initial : targetTree), '检查暂存区与所选模式的预期是否一致。');
        add(this.route === 'hard' ? '工作区回到第二版' : '工作区保留第三版', same(state.work, this.route === 'hard' ? targetTree : initial) && !dirty && !state.pending, '检查文件内容；切换模式前需要重置场景。');
      } else if (this.scene === 'remote') {
        const remote = state.remote.branches.main, initialRemote = baseline.remote.branches.main;
        add('远程历史已下载到本地', Boolean(state.commits[initialRemote]) && ancestors(state, state.tracking.main).has(initialRemote), '执行 git fetch origin，或通过 pull 下载远程历史。');
        const integrated = this.route === 'merge' ? hasMerge(main) && ancestors(state, main).has(oldMain) && ancestors(state, main).has(initialRemote) : replayedOnto(state, main, initialRemote, oldMain);
        add(this.route === 'merge' ? '通过合并整合双方历史' : '本地提交重放在远程历史之后', integrated && mainTree['notes.txt'] === initial['notes.txt'] && typeof mainTree['team.txt'] === 'string' && mainTree['team.txt'].includes(treeAt({ commits: baseline.remote.commits }, initialRemote)['team.txt']), '按所选方案执行 pull，并保留 notes.txt 与 team.txt。');
        add('本地、跟踪引用与远程 main 一致', integrated && main === remote && state.tracking.main === remote, 'pull 之后还需要 git push；fetch 本身不会上传提交。');
        add('HEAD 在 main，工作区干净', state.head.branch === 'main' && clean, '完成整合与推送，并处理剩余文件改动。');
      }
      const passed = checks.filter(check => check.passed).length;
      return { checks, passed, total: checks.length, complete: passed === checks.length, dirty };
    }
  }

  /** 原生 details 支持键盘展开；点击参考命令只填入输入框，不执行答案。 */
  class View {
    constructor(anchor, onCommand, onRoute) {
      this.onCommand = onCommand; this.onRoute = onRoute;
      this.make = (tag, className, text) => {
        const element = document.createElement(tag); element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
      };
      const node = this.make;
      this.root = node('details', 'lesson-guide'); this.root.id = 'lesson-guide';
      this.summary = node('summary', 'lesson-summary');
      this.badge = node('span', 'lesson-badge');
      this.summary.append(node('strong', '', '参考答案与验收'), this.badge, node('span', 'lesson-toggle', '展开查看步骤'));
      this.body = node('div', 'lesson-body');
      this.goal = node('p', 'lesson-goal');
      const label = node('label', 'lesson-route-label', '参考方案');
      this.select = node('select', 'lesson-route'); this.select.id = 'lesson-route'; label.htmlFor = this.select.id;
      this.select.addEventListener('change', () => this.onRoute(this.select.value));
      this.routeBar = node('div', 'lesson-route-bar'); this.routeBar.append(label, this.select);
      this.notice = node('p', 'lesson-notice', '每个方案从本场景初始状态开始。命令逐条执行，点击只填入；不同方案请先重置场景再比较。');
      this.steps = node('ol', 'lesson-steps'); this.expected = node('p', 'lesson-expected'); this.note = node('p', 'lesson-notice');
      this.checks = node('ul', 'lesson-checks');
      this.status = node('p', 'lesson-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
      this.body.append(this.goal, this.routeBar, this.notice, node('h3', '', '参考步骤'), this.steps, this.expected, this.note, node('h3', '', '当前验收结果'), this.status, this.checks, node('p', 'lesson-notice', '验收随当前状态更新；后续编辑可能回到待完成。等效命令也可以达标，提交说明和模拟 ID 不必完全相同。'));
      this.root.append(this.summary, this.body); anchor.before(this.root);
    }

    update(practice, state, dirty) {
      const lesson = LESSONS[practice.scene], route = lesson.routes.find(item => item.id === practice.route), node = this.make;
      if (this.scene !== practice.scene) {
        this.select.replaceChildren(...lesson.routes.map(item => {
          const option = node('option', '', item.title); option.value = item.id; return option;
        }));
      }
      if (this.scene !== practice.scene || this.route !== practice.route) {
        this.goal.textContent = '本关目标：' + lesson.goal; this.select.value = practice.route;
        this.steps.replaceChildren(...route.steps.map(step => {
          const row = node('li', '');
          if (step.command) {
            const button = node('button', 'lesson-command', step.command); button.type = 'button'; button.title = '点击填入，检查后按 Enter 执行';
            button.addEventListener('click', () => this.onCommand(step.command)); row.append(button);
          } else { row.append(node('span', '', step.instruction), node('pre', 'lesson-sample', step.content)); }
          return row;
        }));
        this.expected.textContent = '预期结果：' + route.expected;
        this.note.textContent = lesson.note || ''; this.note.hidden = !lesson.note;
        this.body.scrollTop = 0;
        this.scene = practice.scene; this.route = practice.route;
      }
      const result = practice.evaluate(state, dirty);
      this.badge.textContent = result.complete ? '本方案已完成 ✓' : '待完成 ' + result.passed + '/' + result.total;
      this.root.classList.toggle('lesson-complete', result.complete);
      const text = result.complete ? '本方案已完成，全部验收条件通过。' : '已通过 ' + result.passed + '/' + result.total + ' 项。' + (dirty ? '编辑器还有未保存草稿。' : '请对照下方待完成项继续练习。');
      if (this.status.textContent !== text) this.status.textContent = text;
      this.checks.replaceChildren(...result.checks.map(check => {
        const row = node('li', check.passed ? 'passed' : '');
        row.append(node('span', 'lesson-check-label', (check.passed ? '✓ 已通过 · ' : '○ 待完成 · ') + check.label), node('small', '', check.detail));
        return row;
      }));
    }
  }

  const api = { LESSONS, Practice, View };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitLessons = api;
})(globalThis);
