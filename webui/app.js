(function () {
  'use strict';
  const { Simulator, SCENES, edits } = GitSimulator;
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const sim = new Simulator();
  let selectedFile = 'hello.txt', selectedCommit = null, dirty = false, history = [], historyIndex = 0, draft = '', lastResult = null, replayTimer = null;
  const graph = new CommitGraph($('graph'), showCommit);
  const assistant = new GitCommandAssist.Controller($('command'), assistContext);
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

  /** 用户输入只进入 textContent、value 或 SVG 文本节点，不拼接 HTML。 */
  function terminalEntry(command, output, type = '') {
    const entry = node('div', 'terminal-entry');
    entry.append(node('div', 'terminal-command', command), node('pre', 'terminal-output ' + type, output));
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

  function commandButton(command) {
    const button = node('button', 'command-chip', command);
    button.type = 'button'; button.addEventListener('click', () => { $('help-dialog').close(); fillCommand(command); });
    return button;
  }

  function loadScene(scene) {
    cancelReplay(); sim.loadScene(scene); selectedFile = 'hello.txt'; selectedCommit = null; dirty = false; lastResult = null;
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
      $('conflict-tip').textContent = '编辑工作区 → 保存 → git add → git ' + op.type + ' --continue';
      $('ours-label').textContent = op.type === 'rebase' ? '当前版本 · 新基点上的历史' : '当前版本 · HEAD';
      $('theirs-label').textContent = op.type === 'rebase' ? '传入版本 · 待重放的提交' : '传入版本 · ' + (op.type === 'revert' ? '反向改动' : '另一分支');
      $('conflict-base').textContent = conflict.base ?? '（此版本没有该文件）'; $('conflict-ours').textContent = conflict.ours ?? '（此版本删除了文件）'; $('conflict-theirs').textContent = conflict.theirs ?? '（此版本删除了文件）';
    }
    renderCode($('work-diff'), work, index, true);
    renderRecommendations();
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
    terminalEntry('$ ' + input, result.output, !result.ok ? 'terminal-error' : result.conflict ? 'terminal-conflict' : '');
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
  const manual = [
    ['查看状态与差异', [['git status', '查看三个区域和同步状态'], ['git log --oneline --graph --all', '可达历史；文本列出父提交'], ['git diff', '工作区与暂存区差异'], ['git diff --cached', '暂存区与 HEAD 差异']]],
    ['暂存与提交', [['git add hello.txt', '支持多个文件，含空格的路径加引号'], ['git add .', '暂存所有新增、修改和删除'], ['git commit -m "学习 Git"', '提交暂存内容，中文说明可用']]],
    ['分支与切换', [['git branch', '列出本地分支'], ['git branch bugFix', '在当前提交创建分支'], ['git branch -d bugFix', '仅删除已合入目标的非当前分支'], ['git switch -c feature', '创建并切换分支'], ['git switch main', '切换已有本地分支'], ['git checkout -b feature', '创建并切换分支'], ['git checkout C0', '切换分支或提交；提交进入分离 HEAD']]],
    ['合并', [['git merge bugFix', '快进或创建双亲提交'], ['git merge --no-ff bugFix', '需要合并时强制创建合并提交'], ['git merge --continue', '解决冲突并 add 后继续'], ['git merge --abort', '恢复操作前状态']]],
    ['变基', [['git rebase main', '将当前线性分支重放到目标之上'], ['git rebase --continue', '解决冲突并 add 后继续'], ['git rebase --abort', '恢复变基前状态']]],
    ['Reset 与 Revert', [['git reset --soft HEAD~1', '只移动分支/HEAD'], ['git reset --mixed HEAD~1', '同时重置暂存区；省略模式时默认 mixed'], ['git reset --hard HEAD~1', '同时重置已跟踪文件，未跟踪文件通常保留'], ['git reset', '默认 mixed，目标默认 HEAD'], ['git revert HEAD', '用新提交抵消一个普通提交'], ['git revert --continue', '解决冲突并 add 后继续'], ['git revert --abort', '中止撤回']]],
    ['虚拟远程协作', [['git fetch origin', '只下载对象、更新 origin/*'], ['git pull', '先 fetch，再 merge；需要已配置上游'], ['git pull --no-rebase origin main', '明确使用合并'], ['git pull --rebase origin main', '明确使用变基'], ['git push', '推送到当前分支的上游'], ['git push origin main', '推送指定同名分支'], ['git push -u origin bugFix', '推送并设置上游']]],
    ['提交引用', [['git checkout HEAD~1', '第一父链向前一代，支持 HEAD~n'], ['git checkout HEAD^', '默认第一个父提交；也可用 ^2'], ['git checkout 0000001', '模拟短 ID；也可直接用 C0'], ['git merge origin/main', '使用最近 fetch 的本地远程跟踪引用']]]
  ];
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
  $('file-editor').addEventListener('input', () => { dirty = true; $('editor-status').textContent = '编辑草稿 · 执行命令时自动保存'; renderRecommendations(); });
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
  document.addEventListener('keydown', event => { if (event.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('help-dialog').open) $('help-dialog').showModal(); });
  $('zoom-in').addEventListener('click', () => graph.setZoom(graph.zoom + .2)); $('zoom-out').addEventListener('click', () => graph.setZoom(graph.zoom - .2)); $('zoom-reset').addEventListener('click', () => graph.setZoom(1));
  window.addEventListener('resize', () => graph.resize());
  loadScene('basic');
})();
