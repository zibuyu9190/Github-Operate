(function () {
  'use strict';
  const { Simulator, SCENES, edits } = GitSimulator;
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const sim = new Simulator();
  let lesson = new GitLessons.Practice(sim.scene, sim.snapshot());
  let selectedFile = 'hello.txt', selectedCommit = null, dirty = false, history = [], historyIndex = 0, draft = '', lastResult = null, replayTimer = null;
  const graph = new CommitGraph($('graph'), showCommit);
  const graphViewer = new GitGraphViewer(graph, $('graph-stage'), () => ({ state: sim.state, title: SCENES[sim.scene].title }), cancelReplay);
  const assistant = new GitCommandAssist.Controller($('command'), assistContext);
  const lessonView = new GitLessons.View($('graph-stage'), fillCommand, route => { lesson.route = route; renderLesson(); });
  const labels = ['编辑与提交', '分叉与汇合', '解决同一行冲突', '改变提交的基点', '理解三种模式', '本地与远程同步'];

  /** 草稿也参与下一步推荐，但读取建议本身不会保存文件或改变虚拟仓库。 */
  function assistContext() {
    const files = sim.fileStatus().map(file => ({ ...file }));
    let state = sim.state;
    if (dirty && selectedFile) {
      const file = files.find(file => file.path === selectedFile);
      if (file) file.unstaged = $('file-editor').value !== sim.state.index[selectedFile];
      state = { ...sim.state, work: { ...sim.state.work, [selectedFile]: $('file-editor').value } };
    }
    return { state, files, scene: sim.scene };
  }

  function renderRecommendations() {
    const rows = GitCommandAssist.recommend(assistContext());
    $('quick-commands').replaceChildren(...rows.map(({ command, description }) => {
      const button = node('button', 'command-chip recommended-command'); button.type = 'button';
      button.append(node('code', '', command), node('small', '', description));
      button.addEventListener('click', () => {
        fillCommand(command);
        const message = command.indexOf('说明本次修改');
        if (message >= 0) $('command').setSelectionRange(message, message + '说明本次修改'.length);
      });
      return button;
    }));
    const title = document.querySelector('.suggestions .small-label');
    title.replaceChildren(document.createTextNode('接下来可以试试 '), node('span', '', '按当前仓库状态推荐 · 点击填入'));
  }

  /** 草稿参与验收但不写入仓库，防止未保存编辑仍显示全部完成。 */
  function renderLesson() {
    lessonView.update(lesson, assistContext().state, dirty);
  }

  /** 命令状态取自实际执行结果；用户文本只进入文本节点，不拼接 HTML。 */
  function terminalEntry(command, output, result = null) {
    const entry = node('div', 'terminal-entry');
    const commandLine = node('div', 'terminal-command', command);
    const type = !result ? '' : !result.ok ? 'terminal-error' : result.conflict ? 'terminal-conflict' : '';
    if (result) {
      const status = !result.ok ? ['error', '✕ 失败'] : result.conflict ? ['conflict', '⚠ 待解决冲突'] : ['success', '✓ 成功'];
      commandLine.append(node('span', 'terminal-command-status terminal-command-' + status[0], status[1]));
    }
    entry.append(commandLine, node('pre', 'terminal-output ' + type, output));
    $('terminal').append(entry);
    while ($('terminal').children.length > 80) $('terminal').firstElementChild.remove();
    $('terminal').scrollTop = $('terminal').scrollHeight;
  }

  function message(text = '', error = false) { $('file-message').textContent = text; $('file-message').classList.toggle('error', error); }

  function fillCommand(command) {
    $('command').value = command; $('command').focus();
    $('command').setSelectionRange(command.length, command.length);
    assistant.refresh(false);
  }

  function commandButton(command, selection = '') {
    const button = node('button', 'command-chip', command);
    button.type = 'button'; button.addEventListener('click', () => {
      $('help-dialog').close(); fillCommand(command);
      const start = selection ? command.indexOf(selection) : -1;
      if (start >= 0) $('command').setSelectionRange(start, start + selection.length);
    });
    return button;
  }

  function loadScene(scene) {
    const previousRoute = lesson.scene === scene ? lesson.route : undefined;
    cancelReplay(); sim.loadScene(scene); selectedFile = 'hello.txt'; selectedCommit = null; dirty = false; lastResult = null;
    lesson = new GitLessons.Practice(scene, sim.snapshot(), previousRoute);
    graph.previous = new Map(); graph.previousTags = new Map();
    const info = SCENES[scene], index = Object.keys(SCENES).indexOf(scene);
    $('scene-number').textContent = 'EXPERIMENT ' + String(index + 1).padStart(2, '0') + ' / 06';
    $('scene-title').textContent = info.title; $('scene-subtitle').textContent = info.subtitle;
    document.querySelectorAll('.scene-button').forEach(button => { const active = button.dataset.scene === scene; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
    $('terminal').replaceChildren(node('div', 'welcome-title', '欢迎来到 ' + info.title + '。'), node('p', 'terminal-welcome', info.hint));
    $('explanation-title').textContent = '观察起点，再试一条命令'; $('explanation').textContent = info.hint;
    $('flow').replaceChildren(); $('command').value = ''; $('commit-detail').open = false; $('commit-summary').textContent = '选择一个提交，查看它的文件快照'; $('commit-content').replaceChildren();
    $('replay').disabled = true; $('new-file-form').hidden = true; assistant.refresh(false); message(); render();
  }

  function render(animate = false) {
    $('head-label').textContent = sim.state.head.branch || ('分离 · ' + sim.headId());
    graph.draw(sim.state, { animate }); renderRemote(); renderFiles();
    if (selectedCommit) {
      const commit = sim.state.commits[selectedCommit] || sim.state.remote.commits[selectedCommit];
      if (commit) showCommit(commit, !Object.hasOwn(sim.state.commits, selectedCommit), false);
    }
  }

  function renderRemote() {
    $('remote-refs').replaceChildren();
    for (const [branch, id] of Object.entries(sim.state.remote.branches)) {
      for (const [label, target] of [['远程实际 ' + branch, id], ['本地 origin/' + branch, sim.state.tracking[branch] || '尚未同步']]) {
        const row = node('div', 'remote-ref'); row.append(node('span', '', label), node('b', '', target)); $('remote-refs').append(row);
      }
    }
  }

  /** 暂存区以 HEAD 为基准展示行级增删；删除的文件仍保留在可选列表中。 */
  function renderCode(container, text, baseline, showDiff = false) {
    container.replaceChildren();
    if (text === undefined && (!showDiff || baseline === undefined)) { container.append(node('span', 'empty-file', '此区域没有该文件')); return; }
    const baseLines = (baseline || '').match(/[^\n]*\n|[^\n]+$/g) || [];
    const changes = showDiff ? edits(baseline, text) : [];
    let cursor = 0;
    const line = (content, type, number) => {
      const row = node('span', 'code-line' + (type ? ' ' + type : ''));
      row.append(node('span', 'line-prefix', type === 'added' ? '+' : type === 'removed' ? '−' : String(number)), document.createTextNode(content.replace(/\n$/, ''))); container.append(row);
    };
    if (!changes.length) {
      const content = (text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
      if (!content.length) container.append(node('span', 'empty-file', text === undefined ? '此区域没有该文件' : '空文件'));
      content.forEach((contentLine, i) => line(contentLine, '', i + 1)); return;
    }
    for (const change of changes) {
      for (; cursor < change.start; cursor++) line(baseLines[cursor], '', cursor + 1);
      for (; cursor < change.end; cursor++) line(baseLines[cursor], 'removed', cursor + 1);
      change.lines.forEach(content => line(content, 'added', ''));
    }
    for (; cursor < baseLines.length; cursor++) line(baseLines[cursor], '', cursor + 1);
  }

  function renderFiles() {
    const files = sim.fileStatus(), paths = files.map(file => file.path);
    if (!paths.includes(selectedFile)) selectedFile = paths[0] || '';
    $('file-select').replaceChildren(...paths.map(path => { const option = node('option', '', path); option.value = path; return option; }));
    $('file-select').value = selectedFile; $('file-select').disabled = !paths.length;
    const state = files.find(file => file.path === selectedFile), head = sim.headTree()[selectedFile], index = sim.state.index[selectedFile], work = sim.state.work[selectedFile];
    renderCode($('head-file'), head); renderCode($('index-file'), index, head, true);
    if (!dirty) $('file-editor').value = work ?? '';
    $('file-editor').disabled = !selectedFile; $('save-file').disabled = !selectedFile; $('delete-file').disabled = !selectedFile || work === undefined;
    $('editor-status').textContent = dirty ? '编辑草稿尚未保存' : work === undefined ? '工作区已删除 · 保存可恢复' : '编辑后保存到工作区';
    $('file-state').replaceChildren();
    if (state) {
      $('file-state').append(node('span', '', selectedFile));
      if (state.conflict) $('file-state').append(node('span', 'state-tag conflict', '冲突待解决'));
      else if (!state.staged && !state.unstaged) $('file-state').append(node('span', 'state-tag', '三个区域一致'));
      if (state.staged) $('file-state').append(node('span', 'state-tag', '已暂存'));
      if (state.untracked) $('file-state').append(node('span', 'state-tag dirty', '未跟踪'));
      else if (state.unstaged) $('file-state').append(node('span', 'state-tag dirty', state.deleted ? '工作区删除' : '未暂存改动'));
      const markers = /^(<<<<<<< |=======|>>>>>>> )/m.test(work || '');
      if (markers) $('file-state').append(node('span', 'state-tag conflict', '仍有冲突标记，请检查'));
    }
    const conflict = sim.state.pending?.conflicts[selectedFile]; $('conflict-panel').hidden = !conflict;
    if (conflict) {
      const op = sim.state.pending;
      $('conflict-title').textContent = op.unresolved.includes(selectedFile) ? '冲突待解决 · ' + selectedFile : '已暂存解决结果 · ' + selectedFile;
      $('conflict-tip').textContent = op.type === 'stash' ? '编辑工作区 → 保存 → git add；全部解决后即可正常提交，stash 记录仍保留' : '编辑工作区 → 保存 → git add → git ' + op.type + ' --continue';
      $('ours-label').textContent = op.type === 'rebase' ? '当前版本 · 新基点上的历史' : '当前版本 · HEAD';
      $('theirs-label').textContent = op.type === 'rebase' ? '传入版本 · 待重放的提交' : '传入版本 · ' + (op.type === 'revert' ? '反向改动' : op.type === 'stash' ? 'stash 中的改动' : '另一分支');
      $('conflict-base').textContent = conflict.base ?? '（此版本没有该文件）'; $('conflict-ours').textContent = conflict.ours ?? '（此版本删除了文件）'; $('conflict-theirs').textContent = conflict.theirs ?? '（此版本删除了文件）';
    }
    renderCode($('work-diff'), work, index, true);
    renderRecommendations(); renderLesson();
  }

  function showCommit(commit, remoteOnly, expand = true) {
    selectedCommit = commit.id; $('commit-summary').textContent = commit.id + ' · ' + commit.message + (remoteOnly ? '（仅远程）' : '');
    const content = $('commit-content'); content.replaceChildren();
    content.append(node('p', '', '模拟短 ID：' + commit.hash + ' · 父提交：' + (commit.parents.join('、') || '无（初始提交）')));
    for (const [path, text] of Object.entries(commit.tree)) content.append(node('strong', '', path), node('pre', '', text || '（空文件）'));
    if (!Object.keys(commit.tree).length) content.append(node('p', '', '空文件树'));
    if (expand) $('commit-detail').open = true;
  }

  function saveEditor(quiet = false) {
    try {
      if (!selectedFile) return false;
      sim.editFile(selectedFile, $('file-editor').value); dirty = false; renderFiles();
      if (!quiet) message('已保存到工作区。输入 git add 将改动放入暂存区。');
      return true;
    } catch (error) { message(error.message, true); return false; }
  }

  function updateExplanation(result, command) {
    $('explanation-title').textContent = result.ok ? (result.conflict ? '遇到冲突，先停下来看看' : command) : '这条命令需要调整';
    $('explanation').textContent = result.ok ? result.explanation : result.output + ' ' + result.explanation;
    $('flow').replaceChildren();
    if (result.ok && ['add', 'commit', 'reset'].includes(result.command?.name)) {
      ['工作区', '→', '暂存区', '→', '提交 / HEAD'].forEach((text, i) => {
        const active = (result.command.name === 'add' && i === 2) || (result.command.name === 'commit' && i === 4) || result.command.name === 'reset';
        $('flow').append(node('span', active ? 'flow-active' : '', text));
      });
    }
    if (result.ok && result.command?.name === 'restore') {
      const labels = result.command.staged ? ['HEAD', '→', '暂存区', '· 工作区保留'] : ['暂存区', '→', '工作区', '· 丢弃未暂存修改'];
      labels.forEach((text, i) => $('flow').append(node('span', i === 2 ? 'flow-active' : '', text)));
    }
    if (result.ok && result.command?.name === 'stash' && result.command.action !== 'list') {
      const labels = result.command.action === 'push' ? ['工作区 / 暂存区', '→', 'stash@{0}'] : ['stash@{0}', '→', '工作区 / 暂存区'];
      labels.forEach((text, i) => $('flow').append(node('span', i === 2 ? 'flow-active' : '', text)));
    }
    animateFiles(result);
  }

  /** 重播暂存或提交时也重播区域流转提示，无需再次执行命令。 */
  function animateFiles(result) {
    $('flow').classList.remove('flash'); void $('flow').offsetWidth; $('flow').classList.add('flash');
    $('files-title').closest('.files-panel').classList.remove('file-flowing', 'commit-flowing');
    if (result.ok && ['add', 'commit'].includes(result.command?.name)) {
      void $('files-title').offsetWidth;
      $('files-title').closest('.files-panel').classList.add(result.command.name === 'add' ? 'file-flowing' : 'commit-flowing');
    }
  }

  function runCommand(event) {
    event.preventDefault(); cancelReplay();
    if (dirty && !saveEditor(true)) return;
    const input = $('command').value.trim(); if (!input) return;
    history.push(input); historyIndex = history.length; draft = '';
    const result = sim.execute(input);
    lesson.record(result);
    terminalEntry('$ ' + input, result.output, result);
    $('command').value = ''; assistant.refresh(false); message(); dirty = false; render(result.ok); updateExplanation(result, input);
    if (result.ok) { lastResult = result; $('replay').disabled = false; }
    if (result.ok && result.conflict) { selectedFile = sim.state.pending.unresolved[0]; renderFiles(); }
    if (result.ok && result.command.name !== 'log') requestAnimationFrame(() => { $('graph-stage').scrollTop = $('graph-stage').scrollHeight; });
  }

  /** 重播只切换图形视图，不重新执行命令，也不改动当前虚拟仓库。 */
  function cancelReplay() { if (replayTimer) clearTimeout(replayTimer); replayTimer = null; $('graph-stage').classList.remove('replaying'); if (lastResult) $('replay').disabled = false; }

  function replay() {
    if (!lastResult) return;
    cancelReplay(); $('replay').disabled = true;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { graph.draw(lastResult.after); animateFiles(lastResult); $('replay').disabled = false; return; }
    $('graph-stage').classList.add('replaying'); graph.draw(lastResult.before);
    replayTimer = setTimeout(() => { graph.draw(lastResult.after, { animate: true }); animateFiles(lastResult); $('graph-stage').classList.remove('replaying'); $('replay').disabled = false; replayTimer = null; }, 700);
  }

  Object.entries(SCENES).forEach(([key, info], i) => {
    const button = node('button', 'scene-button'); button.type = 'button'; button.dataset.scene = key;
    const copy = node('span', 'scene-copy'); copy.append(node('strong', '', info.title), node('small', '', labels[i]));
    button.append(node('span', 'scene-index', String(i + 1).padStart(2, '0')), copy); button.addEventListener('click', () => loadScene(key)); $('scenes').append(button);
  });
  $('help-title').textContent = 'Git 命令手册与常用流程';
  document.querySelector('#help-dialog > p').textContent = '单条命令可在网页内练习；含 && 的组合行供真实终端参考。点击模板或分步命令只会填入输入框，请检查后再按 Enter 执行。';

  /** 占位符用于讲解语法；点击时改用有效示例并选中变量，避免把尖括号当成实际参数。 */
  const templates = [
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
  const templateGroup = node('section', 'help-group help-templates');
  templateGroup.append(node('h3', '', '常用命令模板 · 点击填入可编辑示例'), node('p', 'help-note', '<your-branch-name>、<file-path> 和 <message> 都是占位符，需要替换，不要输入尖括号。点击后会选中需要修改的示例内容。'));
  for (const [template, description, example, selection] of templates) {
    const row = node('div', 'help-row help-template-row'), button = commandButton(example, selection);
    button.textContent = template; button.title = '点击填入示例：' + example;
    row.append(button, node('span', '', description)); templateGroup.append(row);
  }
  $('help-content').append(templateGroup);

  /** && 不交给模拟引擎执行；组合行只展示，分步按钮逐条填入支持的命令。 */
  const workflows = [
    ['提交并推送', 'git commit -m "<message>" && git push', '适合已有暂存改动，且当前分支已设置上游的情况。', [['git commit -m "完成本次修改"', '完成本次修改'], ['git push']]],
    ['暂存全部改动、提交并推送', 'git add . && git commit -m "<message>" && git push', '先编辑文件，再暂存、提交和推送；当前分支需要已设置上游。没有可提交的改动时，commit 会失败，后续 push 不会执行。', [['git add .'], ['git commit -m "完成本次修改"', '完成本次修改'], ['git push']]],
    ['提交并首次发布新分支', 'git add . && git commit -m "<message>" && git push -u origin <your-branch-name>', '先用 switch -c 创建并切换分支，再编辑文件。把最后的分支名换成当前分支名，首次推送后会建立跟踪关系。', [['git add .'], ['git commit -m "完成本次修改"', '完成本次修改'], ['git push -u origin feature-demo', 'feature-demo']]],
    ['切换主分支并更新', 'git switch main && git pull --no-rebase origin main', '先保存并提交改动，保持工作区干净，再切换 main 并合并远程更新。', [['git switch main'], ['git pull --no-rebase origin main']]],
    ['取消全部暂存，保留修改', 'git reset --mixed HEAD', '暂存区回到 HEAD，工作区内容保留。随后可以重新选择文件 add；不会撤回提交。', [['git reset --mixed HEAD']]],
    ['合并功能分支并清理', 'git switch main && git merge <your-branch-name> && git branch -d <your-branch-name>', '先保持工作区干净，再合入功能分支。发生冲突时先解决，合并成功后再删除分支；已设置上游的分支还须已合入上游，-d 才允许删除。', [['git switch main'], ['git merge feature-demo', 'feature-demo'], ['git branch -d feature-demo', 'feature-demo']]],
    ['解决合并冲突后继续', 'git add <file-path> && git merge --continue', '先在文件区编辑并保存，删除所有冲突标记，再 add 所有解决文件并继续；还有冲突时不能继续。', [['git add hello.txt', 'hello.txt'], ['git merge --continue']]],
    ['解决变基冲突后继续', 'git add <file-path> && git rebase --continue', '编辑并保存当前重放提交的冲突，add 后继续；后续提交可能再次暂停。stash pop 冲突全部 add 后即可正常提交，没有 --continue。', [['git add hello.txt', 'hello.txt'], ['git rebase --continue']]],
    ['临时保存，切换分支，再恢复', 'git stash push -u -m "临时保存" && git switch <your-branch-name> && git stash pop', '保存当前改动后切换到已存在的目标分支，再恢复改动。pop 成功后移除记录，冲突时保留；可先 stash list 核对。', [['git stash push -u -m "临时保存"'], ['git switch main', 'main'], ['git stash list'], ['git stash pop']]]
  ];
  const flowGroup = node('section', 'help-group help-workflows');
  flowGroup.append(node('h3', '', '常用组合流程 · 真实终端整行执行'), node('p', 'help-note help-terminal-note', '&& 在 PowerShell 7、Git Bash 等终端中表示：前一步成功才执行下一步。失败后会停止后续命令，已成功的步骤不会自动撤销。网页暂不支持 &&，请依次点击下面的分步命令，逐条执行。'));
  for (const [title, chain, description, steps] of workflows) {
    const card = node('article', 'help-flow'), code = node('pre', 'help-chain', chain), actions = node('div', 'help-flow-steps');
    card.append(node('h4', '', title), code, node('p', 'help-note', description), node('div', 'help-step-label', '网页分步练习 · 按顺序点击填入，再按 Enter 执行'));
    steps.forEach(([command, selection], i) => { const button = commandButton(command, selection); button.textContent = (i + 1) + ' · ' + command; actions.append(button); });
    card.append(actions); flowGroup.append(card);
  }
  const sources = node('p', 'help-note help-sources', '参考：');
  for (const [title, url] of [['Git switch', 'https://git-scm.com/docs/git-switch'], ['Git commit', 'https://git-scm.com/docs/git-commit'], ['Git push', 'https://git-scm.com/docs/git-push'], ['PowerShell &&', 'https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_pipeline_chain_operators']]) {
    const link = node('a', '', title); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.append(link);
  }
  flowGroup.append(sources); $('help-content').append(flowGroup);

  const manual = [
    ['查看状态与差异', [['git status', '查看三个区域和同步状态'], ['git log --oneline --graph --all', '可达历史；文本列出父提交'], ['git show HEAD', '查看提交说明与改动；也可指定分支或提交 ID'], ['git diff', '工作区与暂存区差异'], ['git diff --cached', '暂存区与 HEAD 差异']]],
    ['暂存、提交与临时保存', [['git add hello.txt', '支持多个文件，含空格的路径加引号'], ['git add .', '暂存所有新增、修改和删除'], ['git restore --staged hello.txt', '取消该文件暂存，保留工作区修改'], ['git restore hello.txt', '恢复为暂存区内容，丢弃该文件未暂存修改'], ['git restore --staged .', '取消全部暂存，保留工作区修改'], ['git commit -m "学习 Git"', '提交暂存内容，中文说明可用'], ['git stash push -m "临时保存"', '保存已跟踪改动；未跟踪文件保留在工作区'], ['git stash push -u -m "临时保存"', '连未跟踪文件一起保存，HEAD 不变'], ['git stash list', '列出保存记录，stash@{0} 为最近一份'], ['git stash pop', '恢复最近一份，成功后移除，冲突时保留；普通修改需重新 add']]],
    ['分支与切换', [['git branch', '列出本地分支'], ['git branch -a', '列出本地与远程跟踪分支'], ['git branch -vv', '查看上游以及领先/落后数量，依据最近同步'], ['git branch bugFix', '在当前提交创建分支'], ['git branch -d bugFix', '仅删除已合入目标的非当前分支'], ['git switch -c feature', '创建并切换分支'], ['git switch main', '切换已有本地分支'], ['git checkout -b feature', '创建并切换分支'], ['git checkout C0', '切换分支或提交；提交进入分离 HEAD']]],
    ['合并', [['git merge bugFix', '快进或创建双亲提交'], ['git merge --no-ff bugFix', '需要合并时强制创建合并提交'], ['git merge --continue', '解决冲突并 add 后继续'], ['git merge --abort', '恢复操作前状态']]],
    ['变基', [['git rebase main', '将当前线性分支重放到目标之上'], ['git rebase --continue', '解决冲突并 add 后继续'], ['git rebase --abort', '恢复变基前状态']]],
    ['Reset 与 Revert', [['git reset --soft HEAD~1', '只移动分支/HEAD'], ['git reset --mixed HEAD~1', '同时重置暂存区；省略模式时默认 mixed'], ['git reset --mixed HEAD', '取消全部暂存，保留工作区修改和当前提交'], ['git reset --hard HEAD~1', '同时重置已跟踪文件，未跟踪文件通常保留'], ['git reset', '默认 mixed，目标默认 HEAD'], ['git revert HEAD', '用新提交抵消一个普通提交'], ['git revert --continue', '解决冲突并 add 后继续'], ['git revert --abort', '中止撤回']]],
    ['虚拟远程协作', [['git remote -v', '查看虚拟 origin；不读取真实仓库地址'], ['git fetch origin', '只下载对象、更新 origin/*'], ['git pull', '先 fetch，再 merge；需要已配置上游'], ['git pull --no-rebase origin main', '明确使用合并'], ['git pull --rebase origin main', '明确使用变基'], ['git push', '推送到当前分支的上游'], ['git push origin main', '推送指定同名分支'], ['git push -u origin bugFix', '推送并设置上游']]],
    ['提交引用', [['git checkout HEAD~1', '第一父链向前一代，支持 HEAD~n'], ['git checkout HEAD^', '默认第一个父提交；也可用 ^2'], ['git checkout 0000001', '模拟短 ID；也可直接用 C0'], ['git merge origin/main', '使用最近 fetch 的本地远程跟踪引用']]]
  ];
  const stashNote = node('p', 'help-note', '练习边界：restore 支持明确文件名和 .，冲突中请编辑后 add。stash pop 只恢复最近一份，要求已跟踪文件和暂存区干净；不支持 --index、apply、drop。stash 使用独立快照保存，不在提交图中新增普通提交；刷新或切换场景会清空。参考：');
  for (const name of ['restore', 'stash', 'show', 'branch', 'remote']) {
    const link = node('a', '', 'Git ' + name + ' '); link.href = 'https://git-scm.com/docs/git-' + name; link.target = '_blank'; link.rel = 'noopener noreferrer'; stashNote.append(link);
  }
  templateGroup.append(stashNote);
  for (const [title, rows] of manual) {
    const group = node('section', 'help-group'); group.append(node('h3', '', title));
    for (const [command, description] of rows) { const row = node('div', 'help-row'); row.append(commandButton(command), node('span', '', description)); group.append(row); }
    $('help-content').append(group);
  }
  // 工作区保留可编辑文本，同时提供按行着色的差异视图。
  const workDetails = node('details', 'work-diff'); workDetails.append(node('summary', '', '查看工作区相对暂存区的差异'));
  const workDiff = node('pre', 'code-view'); workDiff.id = 'work-diff'; workDetails.append(workDiff);
  $('file-editor').after(workDetails);
  $('command-form').addEventListener('submit', runCommand);
  $('command').addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || assistant.composing) return;
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !history.length) return;
    event.preventDefault();
    if (historyIndex === history.length) draft = $('command').value;
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    $('command').value = historyIndex === history.length ? draft : history[historyIndex];
    $('command').setSelectionRange($('command').value.length, $('command').value.length);
    assistant.refresh(false);
  });
  $('file-editor').addEventListener('input', () => { dirty = true; $('editor-status').textContent = '编辑草稿 · 执行命令时自动保存'; renderRecommendations(); renderLesson(); });
  $('save-file').addEventListener('click', () => saveEditor());
  $('file-select').addEventListener('change', () => { const target = $('file-select').value; if (dirty && !saveEditor(true)) { $('file-select').value = selectedFile; return; } selectedFile = target; dirty = false; message(); renderFiles(); });
  $('delete-file').addEventListener('click', () => { try { sim.deleteFile(selectedFile); dirty = false; renderFiles(); message('已从虚拟工作区删除。输入 git add 暂存这次删除。'); } catch (error) { message(error.message, true); } });
  $('new-file').addEventListener('click', () => { $('new-file-form').hidden = false; $('new-path').focus(); });
  $('cancel-new').addEventListener('click', () => { $('new-file-form').hidden = true; });
  $('new-file-form').addEventListener('submit', event => {
    event.preventDefault();
    if (dirty && !saveEditor(true)) return;
    const path = $('new-path').value.trim();
    try {
      if (Object.hasOwn(sim.state.work, path)) throw new Error('工作区已有同名文件，请从文件列表中选择。');
      sim.editFile(path, ''); selectedFile = path; dirty = false; $('new-file-form').hidden = true; $('new-path').value = ''; renderFiles(); $('file-editor').focus(); message('已创建虚拟文件，请输入内容并保存。');
    } catch (error) { message(error.message, true); }
  });
  for (const [id, side] of [['use-ours', 'ours'], ['use-theirs', 'theirs']]) {
    $(id).addEventListener('click', () => {
      const conflict = sim.state.pending?.conflicts[selectedFile]; if (!conflict) return;
      if (conflict[side] === null) { if (Object.hasOwn(sim.state.work, selectedFile)) sim.deleteFile(selectedFile); }
      else sim.editFile(selectedFile, conflict[side]);
      dirty = false; renderFiles(); message('已选择此版本，请检查内容，再 git add 并继续。');
    });
  }
  $('remote-commit').addEventListener('click', () => {
    cancelReplay(); const before = sim.snapshot(), result = sim.simulateRemote();
    terminalEntry('☁ 虚拟协作者', result.output); render(true); updateExplanation(result, '远程新增了一次提交');
    lastResult = { ...result, before, after: sim.snapshot() }; $('replay').disabled = false;
  });
  $('replay').addEventListener('click', replay); $('restart').addEventListener('click', () => loadScene(sim.scene));
  $('help-button').addEventListener('click', () => $('help-dialog').showModal()); $('close-help').addEventListener('click', () => $('help-dialog').close());
  $('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const rect = $('help-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('help-dialog').close(); } });
  document.addEventListener('keydown', event => { if (event.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('help-dialog').open && !graphViewer.dialog.open) $('help-dialog').showModal(); });
  $('zoom-in').addEventListener('click', () => graph.setZoom(graph.zoom + .2)); $('zoom-out').addEventListener('click', () => graph.setZoom(graph.zoom - .2)); $('zoom-reset').addEventListener('click', () => graph.setZoom(1));
  window.addEventListener('resize', () => graph.resize());
  loadScene('basic');
})();
