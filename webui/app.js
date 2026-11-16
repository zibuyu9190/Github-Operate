(function () {
  'use strict';
  const { Simulator, RemoteWorkspace, SCENES, edits } = GitSimulator;
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const sim = new Simulator();
  let lesson = new GitLessons.Practice(sim.scene, sim.snapshot());
  let selectedFile = 'hello.txt', selectedCommit = null, dirty = false, history = [], historyIndex = 0, draft = '', lastResult = null, replayTimer = null;
  let remoteBranch = null;
  let editorMode = 'local', localBuffer = '';
  let collaboratorSession = null;
  const commandSessions = new Map();
  const graph = new CommitGraph($('graph'), showCommit);
  const graphViewer = new GitGraphViewer(graph, $('graph-stage'), () => ({ state: graphState(), title: SCENES[sim.scene].title + (editorMode === 'remote' ? ' · 协作者本地' : ' · 我的本地') }), cancelReplay);
  const assistant = new GitCommandAssist.Controller($('command'), assistContext);
  const lessonView = new GitLessons.View($('graph-stage'), command => { switchEditorMode('local'); fillCommand(command); }, route => { lesson.route = route; renderLesson(); });
  const repositoryBrowser = new GitRepositoryBrowser.View(() => ({ state: sim.state }), cancelReplay);
  const labels = ['编辑与提交', '分叉与汇合', '解决同一行冲突', '改变提交的基点', '理解三种模式', '本地与远程同步'];
  const filePanel = $('files-title').closest('.files-panel');
  const repositoryStatus = new GitRepositoryBrowser.StatusView(filePanel, fillCommand);
  const terminalContext = node('div', 'terminal-context');
  const terminalModes = node('div', 'terminal-modes'); terminalModes.setAttribute('role', 'group'); terminalModes.setAttribute('aria-label', '选择命令执行身份');
  const terminalLocal = node('button', '', '我的本地'), terminalRemote = node('button', '', '模拟协作者');
  terminalLocal.type = terminalRemote.type = 'button'; terminalLocal.id = 'terminal-local'; terminalRemote.id = 'terminal-remote';
  terminalLocal.addEventListener('click', () => switchEditorMode('local')); terminalRemote.addEventListener('click', () => switchEditorMode('remote'));
  terminalModes.append(terminalLocal, terminalRemote);
  const terminalBranchLabel = node('label', 'terminal-branch', '协作者分支');
  const terminalBranch = node('select'); terminalBranch.id = 'terminal-branch'; terminalBranchLabel.htmlFor = terminalBranch.id;
  terminalBranch.addEventListener('change', () => selectRemoteBranch(terminalBranch.value));
  terminalBranchLabel.append(terminalBranch);
  const terminalScope = node('p', 'terminal-scope'); terminalScope.id = 'terminal-scope'; terminalScope.setAttribute('role', 'status');
  terminalContext.append(terminalModes, terminalBranchLabel, terminalScope); $('terminal').before(terminalContext);
  $('terminal').closest('.command-panel').classList.add('has-terminal-context');
  $('command').setAttribute('aria-describedby', $('command').getAttribute('aria-describedby') + ' terminal-scope');
  const modeBar = node('div', 'editor-mode-bar'); modeBar.setAttribute('role', 'group'); modeBar.setAttribute('aria-label', '选择文件编辑身份');
  const localModeButton = node('button', 'button quiet small', '我的本地'), remoteModeButton = node('button', 'button quiet small', '模拟协作者');
  localModeButton.type = remoteModeButton.type = 'button'; localModeButton.id = 'editor-local'; remoteModeButton.id = 'editor-remote';
  localModeButton.addEventListener('click', () => switchEditorMode('local'));
  remoteModeButton.addEventListener('click', () => switchEditorMode('remote'));
  modeBar.append(localModeButton, remoteModeButton); $('new-file-form').before(modeBar);
  const remoteToolbar = node('div', 'remote-editor-toolbar');
  const remoteBranchLabel = node('label', '', '协作者本地分支'); remoteBranchLabel.htmlFor = 'editor-remote-branch';
  const remoteBranchSelect = node('select'); remoteBranchSelect.id = 'editor-remote-branch';
  remoteBranchSelect.addEventListener('change', () => selectRemoteBranch(remoteBranchSelect.value));
  const reloadRemote = node('button', 'button quiet small', '获取远程（fetch）'); reloadRemote.type = 'button';
  reloadRemote.title = '获取远程最新历史和 origin/* 引用，保留协作者本地分支与文件';
  reloadRemote.addEventListener('click', () => runRemoteAction('git fetch origin'));
  const remoteBase = node('p', 'remote-editor-base'); remoteBase.id = 'remote-editor-base'; remoteBase.setAttribute('role', 'status');
  remoteToolbar.append(remoteBranchLabel, remoteBranchSelect, reloadRemote, remoteBase); modeBar.after(remoteToolbar);
  const remoteActions = node('div', 'remote-editor-actions');
  const remoteMessageLabel = node('label', '', '协作者提交说明'); remoteMessageLabel.htmlFor = 'remote-message';
  const remoteMessage = node('input'); remoteMessage.id = 'remote-message'; remoteMessage.maxLength = 200; remoteMessage.placeholder = '例如：调整 dev 分支的问候语';
  remoteMessage.addEventListener('input', () => { const session = remoteSession(); if (session) session.message = remoteMessage.value; });
  const stageRemoteFile = node('button', 'button quiet small', '暂存当前文件'), stageRemoteAll = node('button', 'button quiet small', '暂存全部'), submitRemote = node('button', 'button primary small', '提交（commit）'), pushRemote = node('button', 'button primary small', '推送（push）');
  stageRemoteFile.type = stageRemoteAll.type = submitRemote.type = pushRemote.type = 'button'; stageRemoteFile.id = 'remote-stage-file'; stageRemoteAll.id = 'remote-stage-all'; submitRemote.id = 'remote-submit'; pushRemote.id = 'remote-push';
  stageRemoteFile.addEventListener('click', () => stageRemote(false)); stageRemoteAll.addEventListener('click', () => stageRemote(true)); submitRemote.addEventListener('click', commitRemoteEditor); pushRemote.addEventListener('click', () => {
    const workspace = remoteSession()?.workspace;
    if (workspace?.branch) runRemoteAction(workspace.upstreams[workspace.branch] ? 'git push' : 'git push -u origin ' + JSON.stringify(workspace.branch));
  });
  const remoteCommandHint = node('p', 'remote-command-hint', '协作者：编辑 → add 暂存 → commit 提交到协作者本地 → push 发布到共享远程。按钮和命令终端使用同一仓库；推送后“我的本地”才能 fetch / pull 获取。');
  remoteActions.append(remoteMessageLabel, remoteMessage, stageRemoteFile, stageRemoteAll, submitRemote, pushRemote, remoteCommandHint); $('file-message').before(remoteActions);

  /** 一个协作者对应一个多分支仓库，切分支必须经过引擎检查，不能换成另一份独立草稿。 */
  function remoteSession() {
    if (!collaboratorSession) {
      const branches = sim.state.remote.branches;
      const branch = Object.hasOwn(branches, remoteBranch) ? remoteBranch : Object.hasOwn(branches, 'main') ? 'main' : Object.keys(branches)[0];
      if (!branch) return null;
      const workspace = new RemoteWorkspace(branch, sim.state.remote.commits[branches[branch]], sim.state.remote);
      collaboratorSession = { workspace, selectedFile: Object.hasOwn(workspace.work, 'hello.txt') ? 'hello.txt' : Object.keys(workspace.work)[0] || '', dirty: false, buffer: '', message: '' };
    }
    return collaboratorSession;
  }

  function localEditorText() { return editorMode === 'local' ? $('file-editor').value : localBuffer; }

  /** 当前身份决定提交图来源；协作者未 push 的提交不进入“我的本地”或共享远程。 */
  function graphState() { return editorMode === 'remote' ? remoteSession()?.workspace.commandContext(sim).state || sim.state : sim.state; }

  function selectRemoteBranch(branch) {
    switchEditorMode('remote');
    if (branch && branch !== remoteSession()?.workspace.branch) runRemoteAction('git switch ' + JSON.stringify(branch));
    else render();
  }

  /** 切换只保存两边的显示缓冲与历史，不把任何一方未保存的文本写入另一方仓库。 */
  function switchEditorMode(mode) {
    if (mode === editorMode) return;
    cancelReplay(); lastResult = null; $('replay').disabled = true; selectedCommit = null;
    $('commit-detail').open = false; $('commit-summary').textContent = '选择一个提交，查看它的文件快照'; $('commit-content').replaceChildren();
    commandSessions.set(editorMode, { history, historyIndex, draft, input: $('command').value, entries: [...$('terminal').childNodes], scroll: $('terminal').scrollTop });
    if (editorMode === 'local') localBuffer = $('file-editor').value;
    editorMode = mode; $('new-file-form').hidden = true;
    if (mode === 'local') $('file-editor').value = localBuffer;
    const commandSession = commandSessions.get(mode);
    history = commandSession?.history || []; historyIndex = commandSession?.historyIndex || 0; draft = commandSession?.draft || '';
    $('command').value = commandSession?.input || '';
    $('terminal').replaceChildren(...(commandSession?.entries || [node('div', 'welcome-title', '模拟协作者命令终端'), node('p', 'terminal-welcome', '编辑后依次 add、commit、push。commit 保存到协作者本地；push 后共享远程才更新。')]));
    $('terminal').scrollTop = commandSession?.scroll || 0;
    message(); render();
  }

  /** 明示命令目标，编辑区与终端使用同一个身份，避免对另一方的文件执行命令。 */
  function renderTerminalContext() {
    const remote = editorMode === 'remote';
    terminalLocal.setAttribute('aria-pressed', String(!remote)); terminalRemote.setAttribute('aria-pressed', String(remote));
    terminalContext.classList.toggle('is-remote', remote); terminalBranchLabel.hidden = !remote;
    terminalScope.textContent = remote ? '当前操作：协作者本地 · ' + (remoteBranch || '分离 HEAD') + '。支持与我的本地相同的命令；commit 后需 push 才发布到共享远程。' : '当前操作：我的本地 · ' + (sim.state.head.branch || '分离 HEAD') + '。commit 后需 push 才会更新虚拟远程。';
    $('command').placeholder = remote ? '输入协作者命令，如 git add hello.txt' : '输入 Git 命令，如 git status';
    assistant.refresh(false);
  }

  function saveRemoteEditor(quiet = false) {
    const session = remoteSession(); if (!session || !session.selectedFile) return false;
    try {
      session.workspace.editFile(session.selectedFile, $('file-editor').value); session.dirty = false;
      renderFiles(); if (!quiet) message('已保存到协作者工作区，请 add、commit，再 push。'); return true;
    } catch (error) { message(error.message, true); return false; }
  }

  function stageRemote(all) {
    const session = remoteSession(); if (session) runRemoteAction('git add ' + (all ? '.' : JSON.stringify(session.selectedFile)));
  }

  function commitRemoteEditor() {
    const session = remoteSession(); if (session) runRemoteAction('git commit -m ' + JSON.stringify(session.message));
  }

  /** 按钮与命令行复用相同执行入口，避免按钮提交和终端提交出现不同语义。 */
  function runRemoteAction(command) {
    const session = remoteSession(); if (!session || (session.dirty && !saveRemoteEditor(true))) return;
    cancelReplay(); const result = session.workspace.execute(sim, command);
    terminalEntry('[协作者本地 · ' + (remoteBranch || '分离 HEAD') + '] $ ' + command, result.output, result);
    if (result.ok && result.command.name === 'commit') session.message = '';
    if (result.ok && result.conflict) session.selectedFile = session.workspace.pending.unresolved[0];
    render(result.ok); updateExplanation(result, command);
    if (result.ok) {
      lastResult = result; $('replay').disabled = false;
      if (result.commitId) showCommit(session.workspace.commits[result.commitId], false);
    }
    message(result.ok ? result.explanation : result.output, !result.ok);
  }

  /** 草稿也参与下一步推荐，但读取建议本身不会保存文件或改变虚拟仓库。 */
  function localAssistContext() {
    const files = sim.fileStatus().map(file => ({ ...file }));
    let state = sim.state;
    if (dirty && selectedFile) {
      const file = files.find(file => file.path === selectedFile);
      if (file) file.unstaged = localEditorText() !== sim.state.index[selectedFile];
      state = { ...sim.state, work: { ...sim.state.work, [selectedFile]: localEditorText() } };
    }
    return { state, files, scene: sim.scene };
  }

  function assistContext() {
    if (editorMode !== 'remote') return localAssistContext();
    const session = remoteSession();
    if (!session) return { ...localAssistContext(), mode: 'remote', files: [], stale: true };
    const context = session.workspace.commandContext(sim);
    if (session.dirty && session.selectedFile) {
      context.state.work[session.selectedFile] = session.buffer;
      const file = context.files.find(file => file.path === session.selectedFile);
      if (file) file.unstaged = session.buffer !== context.state.index[session.selectedFile];
    }
    return context;
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
    title.replaceChildren(document.createTextNode('接下来可以试试 '), node('span', '', (editorMode === 'remote' ? '按协作者状态推荐' : '按本地状态推荐') + ' · 点击填入'));
  }

  /** 草稿参与验收但不写入仓库，防止未保存编辑仍显示全部完成。 */
  function renderLesson() {
    lessonView.update(lesson, localAssistContext().state, dirty);
  }

  /** 命令状态取自实际执行结果；用户文本只进入文本节点，不拼接 HTML。 */
  function terminalEntry(command, output, result = null) {
    const entry = node('div', 'terminal-entry');
    const commandLine = node('div', 'terminal-command', command);
    const type = !result ? '' : !result.ok ? 'terminal-error' : result.conflict || result.paused ? 'terminal-conflict' : '';
    if (result) {
      const status = !result.ok ? ['error', '✕ 失败'] : result.conflict ? ['conflict', '⚠ 待解决冲突'] : result.paused ? ['conflict', '⚠ 已暂停'] : ['success', '✓ 成功'];
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
    cancelReplay(); sim.loadScene(scene); selectedFile = 'hello.txt'; selectedCommit = null; remoteBranch = null; dirty = false; lastResult = null;
    editorMode = 'local'; localBuffer = ''; collaboratorSession = null; commandSessions.clear(); history = []; historyIndex = 0; draft = '';
    repositoryBrowser.reset();
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
    renderRemote(); const state = graphState();
    $('head-label').textContent = (editorMode === 'remote' ? '协作者 · ' : '') + (state.head.branch || ('分离 · ' + state.head.id));
    graph.draw(state, { animate }); renderFiles();
    if (selectedCommit) {
      const commit = state.commits[selectedCommit] || state.remote.commits[selectedCommit];
      if (commit) showCommit(commit, !Object.hasOwn(state.commits, selectedCommit));
    }
  }

  function renderRemote() {
    const session = remoteSession(), workspace = session?.workspace;
    const branches = workspace ? [...new Set([...Object.keys(workspace.branches), ...Object.keys(workspace.tracking)])].sort() : [];
    const localOnly = Object.keys(sim.state.branches).filter(branch => !Object.hasOwn(sim.state.remote.branches, branch)).sort();
    remoteBranch = workspace?.branch || null;
    const options = branches.map(branch => { const option = node('option', '', branch + (Object.hasOwn(workspace.branches, branch) ? '' : '（跟踪 origin/' + branch + '）')); option.value = branch; return option; });
    for (const branch of localOnly.filter(branch => !branches.includes(branch))) {
      const option = node('option', '', branch + '（仅本地，需先 push）'); option.value = branch; option.disabled = true; options.push(option);
    }
    if (!remoteBranch) { const option = node('option', '', workspace ? '分离 HEAD · ' + workspace.baseId : '暂无远程分支'); option.value = ''; option.disabled = true; options.unshift(option); }
    $('remote-branch').replaceChildren(...options); $('remote-branch').value = remoteBranch || '';
    terminalBranch.replaceChildren(...options.map(option => option.cloneNode(true))); terminalBranch.value = remoteBranch || ''; terminalBranch.disabled = !branches.length;
    remoteBranchSelect.replaceChildren(...options.map(option => option.cloneNode(true))); remoteBranchSelect.value = remoteBranch || ''; remoteBranchSelect.disabled = !branches.length;
    $('remote-branch').disabled = !branches.length; $('remote-commit').disabled = !branches.length;
    $('remote-commit').title = workspace ? '打开协作者本地仓库编辑区' : '先推送一个分支到虚拟远程';
    document.querySelector('label[for="remote-branch"]').textContent = '协作者本地分支';
    $('remote-branch-hint').replaceChildren(document.createTextNode('选择框与 git switch 共用切换保护；新远程分支需 fetch 后可见。'));
    $('remote-refs').replaceChildren();
    for (const [branch, id] of Object.entries(sim.state.remote.branches)) {
      for (const [label, target] of [['远程实际 ' + branch, id], ['本地 origin/' + branch, sim.state.tracking[branch] || '尚未同步']]) {
        const row = node('div', 'remote-ref'); row.append(node('span', '', label), node('b', '', target)); $('remote-refs').append(row);
      }
    }
    for (const [branch, id] of Object.entries(workspace?.branches || {})) {
      const row = node('div', 'remote-ref'); row.append(node('span', '', '协作者本地 ' + branch), node('b', '', id)); $('remote-refs').append(row);
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
    repositoryStatus.update(graphState(), editorMode);
    renderTerminalContext();
    const remote = editorMode === 'remote';
    localModeButton.setAttribute('aria-pressed', String(!remote)); remoteModeButton.setAttribute('aria-pressed', String(remote));
    filePanel.classList.toggle('editing-remote', remote); remoteToolbar.hidden = !remote; remoteActions.hidden = !remote;
    $('files-title').replaceChildren(node('span', 'section-dot green'), document.createTextNode(remote ? '文件与三个区域 · 模拟协作者' : '文件与三个区域 · 我的本地'));
    document.querySelector('.work-area .area-heading > span').textContent = remote ? 'WORKTREE · 协作者编辑' : 'WORKTREE · 直接编辑';
    document.querySelector('.index-area .area-heading > span').textContent = remote ? 'INDEX · 协作者暂存快照' : 'INDEX · git add 快照';
    document.querySelector('.head-area .area-heading > span').textContent = remote ? '协作者 HEAD · ' + (remoteBranch || '') : 'HEAD · 已提交快照';
    document.querySelector('.index-area .area-footer').textContent = remote ? '相对协作者 HEAD：绿色为新增，红色为删除' : '相对 HEAD：绿色为新增，红色为删除';
    document.querySelector('.head-area .area-footer').textContent = remote ? '协作者本地最近一次提交；push 后才发布到共享远程' : '最近一次 git commit 保存的内容';
    if (!remote) { renderLocalFiles(); return; }
    const session = remoteSession();
    if (!session) { $('file-editor').value = ''; $('file-editor').disabled = true; submitRemote.disabled = pushRemote.disabled = reloadRemote.disabled = true; remoteBase.textContent = '暂无远程分支，请先切回本地 push。'; return; }
    const workspace = session.workspace, files = workspace.fileStatus(), paths = files.map(file => file.path);
    if (!paths.includes(session.selectedFile)) session.selectedFile = paths[0] || '';
    const path = session.selectedFile, status = files.find(file => file.path === path);
    $('file-select').replaceChildren(...paths.map(path => { const option = node('option', '', path); option.value = path; return option; }));
    $('file-select').value = path; $('file-select').disabled = !path;
    const readFile = tree => Object.hasOwn(tree, path) ? tree[path] : undefined;
    $('file-editor').value = session.dirty ? session.buffer : readFile(workspace.work) ?? '';
    $('file-editor').disabled = !path; $('save-file').disabled = !path; $('delete-file').disabled = !Object.hasOwn(workspace.work, path);
    renderCode($('head-file'), readFile(workspace.base)); renderCode($('index-file'), readFile(workspace.index), readFile(workspace.base), true);
    renderCode($('work-diff'), session.dirty ? session.buffer : readFile(workspace.work), readFile(workspace.index), true);
    $('file-state').replaceChildren(node('span', '', path || '暂无文件'));
    if (status?.conflict) $('file-state').append(node('span', 'state-tag conflict', '协作者冲突待解决'));
    if (status?.staged) $('file-state').append(node('span', 'state-tag', '协作者已暂存'));
    if (session.dirty || status?.unstaged) $('file-state').append(node('span', 'state-tag dirty', session.dirty ? '协作者草稿未保存' : status.deleted ? '协作者工作区删除' : '协作者未暂存'));
    else if (!status?.staged) $('file-state').append(node('span', 'state-tag', '协作者三个区域一致'));
    $('editor-status').textContent = session.dirty ? '协作者草稿 · 执行命令时自动保存' : '编辑后保存到协作者工作区';
    const context = workspace.commandContext(sim), pending = workspace.pending;
    remoteBase.textContent = '协作者本地 ' + (remoteBranch || '分离 HEAD') + ' · ' + workspace.baseId + ' ｜' + (context.actual ? '共享远程 origin/' + (context.upstream || remoteBranch) + ' · ' + context.actual + ' ｜未推送 ' + context.ahead + ' 个提交' : '当前分支尚未发布') +
      (pending ? pending.type === 'stash' ? '。stash 恢复冲突：编辑后 add，记录仍保留；没有 --continue 或 --abort。' : '。正在 ' + pending.type + '：编辑解决冲突后 add，再 ' + pending.type + ' --continue；也可 --abort。' : !remoteBranch ? '。可用 switch -c 新分支保存提交。' : !context.upstream ? '。未设置上游；可推送并关联当前分支。' : context.behind ? '。远程还有 ' + context.behind + ' 个提交，请先保存并提交改动，再 pull 整合后 push。' : context.ahead ? '。commit 已保存；点击“推送”发布。' : '。与共享远程同步；编辑后依次 add、commit、push。');
    remoteBase.classList.toggle('error', Boolean(context.behind || pending)); stageRemoteFile.disabled = !path; stageRemoteAll.disabled = !files.length;
    submitRemote.disabled = Boolean(pending) || !files.some(file => file.staged);
    pushRemote.disabled = Boolean(pending) || !remoteBranch || (Boolean(context.upstream) && !context.ahead); pushRemote.textContent = context.upstream ? '推送到远程 ' + context.upstream : '推送并关联 ' + (remoteBranch || '分支');
    reloadRemote.disabled = Boolean(pending);
    remoteMessage.value = session.message; renderConflict(context.state, path); renderRecommendations(); renderLesson(); requestAnimationFrame(() => graph.resize());
  }

  function renderLocalFiles() {
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
    renderConflict(sim.state, selectedFile);
    renderCode($('work-diff'), work, index, true);
    renderRecommendations(); renderLesson();
  }

  /** 两个身份共用冲突解释，版本选择按钮仅改动当前身份的工作区。 */
  function renderConflict(state, path) {
    const conflict = state.pending?.conflicts[path]; $('conflict-panel').hidden = !conflict;
    if (conflict) {
      const op = state.pending;
      $('conflict-title').textContent = op.unresolved.includes(path) ? '冲突待解决 · ' + path : '已暂存解决结果 · ' + path;
      $('conflict-tip').textContent = op.type === 'stash' ? '编辑工作区 → 保存 → git add；全部解决后即可正常提交，stash 记录仍保留' : '编辑工作区 → 保存 → git add → git ' + op.type + ' --continue';
      $('ours-label').textContent = op.type === 'rebase' ? '当前版本 · 新基点上的历史' : '当前版本 · HEAD';
      $('theirs-label').textContent = ['rebase', 'cherry-pick'].includes(op.type) ? '传入版本 · 待重放的提交' : '传入版本 · ' + (op.type === 'revert' ? '反向改动' : op.type === 'stash' ? 'stash 中的改动' : '另一分支');
      $('conflict-base').textContent = conflict.base ?? '（此版本没有该文件）'; $('conflict-ours').textContent = conflict.ours ?? '（此版本删除了文件）'; $('conflict-theirs').textContent = conflict.theirs ?? '（此版本删除了文件）';
    }
  }

  /** 选择节点只更新详情，展开与折叠由用户点击标题控制，刷新内容时保留手动选择。 */
  function showCommit(commit, remoteOnly) {
    selectedCommit = commit.id; $('commit-summary').textContent = commit.id + ' · ' + commit.message + (remoteOnly ? '（仅远程）' : '');
    GitGraphViewer.renderCommit($('commit-content'), commit, graphState());
  }

  function saveEditor(quiet = false) {
    if (editorMode === 'remote') return saveRemoteEditor(quiet);
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
      const remote = result.actor === 'remote';
      [remote ? '协作者工作区' : '工作区', '→', remote ? '协作者暂存区' : '暂存区', '→', remote ? '协作者本地提交 / HEAD' : '提交 / HEAD'].forEach((text, i) => {
        const active = (result.command.name === 'add' && i === 2) || (result.command.name === 'commit' && i === 4) || result.command.name === 'reset';
        $('flow').append(node('span', active ? 'flow-active' : '', text));
      });
    }
    if (result.ok && result.actor === 'remote' && result.command?.name === 'push') {
      ['协作者本地提交', '→', '共享远程 · origin/' + result.branch, '· 我的本地尚未 fetch'].forEach((text, i) => $('flow').append(node('span', i === 2 ? 'flow-active' : '', text)));
    }
    if (result.ok && result.command?.name === 'restore') {
      const labels = result.command.staged ? ['HEAD', '→', '暂存区', '· 工作区保留'] : ['暂存区', '→', '工作区', '· 丢弃未暂存修改'];
      labels.forEach((text, i) => $('flow').append(node('span', i === 2 ? 'flow-active' : '', text)));
    }
    if (result.ok && result.command?.name === 'stash' && ['push', 'pop', 'apply'].includes(result.command.action)) {
      const labels = result.command.action === 'push' ? ['工作区 / 暂存区', '→', 'stash@{0}'] : ['stash@{' + (result.command.index || 0) + '}', '→', '工作区 / 暂存区'];
      labels.forEach((text, i) => $('flow').append(node('span', i === 2 ? 'flow-active' : '', text)));
    }
    animateFiles(result);
  }

  /** 重播暂存或提交时也重播区域流转提示，无需再次执行命令。 */
  function animateFiles(result) {
    $('flow').classList.remove('flash'); void $('flow').offsetWidth; $('flow').classList.add('flash');
    $('files-title').closest('.files-panel').classList.remove('file-flowing', 'commit-flowing');
    if (result.ok && (result.actor || 'local') === editorMode && ['add', 'commit'].includes(result.command?.name)) {
      void $('files-title').offsetWidth;
      $('files-title').closest('.files-panel').classList.add(result.command.name === 'add' ? 'file-flowing' : 'commit-flowing');
    }
  }

  function runCommand(event) {
    event.preventDefault(); cancelReplay();
    const input = $('command').value.trim(); if (!input) return;
    const remote = editorMode === 'remote', session = remote ? remoteSession() : null;
    if ((remote ? session?.dirty : dirty) && !saveEditor(true)) return;
    history.push(input); historyIndex = history.length; draft = '';
    const result = remote ? session ? session.workspace.execute(sim, input) : { ok: false, output: '暂无远程分支，请切回本地 push 后再试。', explanation: '命令未执行。' } : sim.execute(input);
    if (!remote) lesson.record(result);
    else if (result.ok && result.command.name === 'commit') { session.message = ''; showCommit(session.workspace.commits[result.commitId], false); }
    terminalEntry('[' + (remote ? '协作者本地 · ' + (remoteBranch || '分离 HEAD') : '我的本地 · ' + (sim.state.head.branch || '分离 HEAD')) + '] $ ' + input, result.output, result);
    if (remote && result.ok && result.conflict) session.selectedFile = session.workspace.pending.unresolved[0];
    $('command').value = ''; message(); if (!remote) dirty = false; render(result.ok); updateExplanation(result, input);
    if (result.ok) { lastResult = result; $('replay').disabled = false; }
    if (!remote && result.ok && result.conflict) { selectedFile = sim.state.pending.unresolved[0]; renderFiles(); }
    if (result.ok && result.command.name !== 'log') requestAnimationFrame(() => { $('graph-stage').scrollLeft = $('graph-stage').scrollWidth; });
  }

  /** 重播只切换图形视图，不重新执行命令，也不改动当前虚拟仓库。 */
  function cancelReplay() { if (replayTimer) clearTimeout(replayTimer); replayTimer = null; $('graph-stage').classList.remove('replaying'); if (lastResult) $('replay').disabled = false; }

  function replay() {
    if (!lastResult) return;
    cancelReplay(); $('replay').disabled = true;
    const before = lastResult.graphBefore || lastResult.before, after = lastResult.graphAfter || lastResult.after;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { graph.draw(after); animateFiles(lastResult); $('replay').disabled = false; return; }
    $('graph-stage').classList.add('replaying'); graph.draw(before);
    replayTimer = setTimeout(() => { graph.draw(after, { animate: true }); animateFiles(lastResult); $('graph-stage').classList.remove('replaying'); $('replay').disabled = false; replayTimer = null; }, 700);
  }

  Object.entries(SCENES).forEach(([key, info], i) => {
    const button = node('button', 'scene-button'); button.type = 'button'; button.dataset.scene = key;
    const copy = node('span', 'scene-copy'); copy.append(node('strong', '', info.title), node('small', '', labels[i]));
    button.append(node('span', 'scene-index', String(i + 1).padStart(2, '0')), copy); button.addEventListener('click', () => loadScene(key)); $('scenes').append(button);
  });
  $('help-title').textContent = 'Git 命令手册与常用流程';
  document.querySelector('#help-dialog > p').textContent = '点击命令示例只会填入输入框，再按 Enter 执行；标为“仅供参考”的条目与含 && 的组合行供真实终端使用。';

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
  const stashNote = node('p', 'help-note', '练习边界：restore 支持明确文件名和 .，冲突中请编辑后 add。stash pop/apply 可指定 stash@{n}，要求已跟踪文件和暂存区干净；不支持 --index。apply 保留记录，pop 成功后移除；drop/clear 只移除记录。stash 使用独立快照保存，不在提交图中新增普通提交；刷新或切换场景会清空。参考：');
  for (const name of ['restore', 'stash', 'show', 'branch', 'remote']) {
    const link = node('a', '', 'Git ' + name + ' '); link.href = 'https://git-scm.com/docs/git-' + name; link.target = '_blank'; link.rel = 'noopener noreferrer'; stashNote.append(link);
  }
  templateGroup.append(stashNote);
  for (const [title, rows] of manual) {
    const group = node('section', 'help-group'); group.append(node('h3', '', title));
    for (const [command, description] of rows) { const row = node('div', 'help-row'); row.append(commandButton(command), node('span', '', description)); group.append(row); }
    $('help-content').append(group);
  }
  // 补充手册与已有分类布局解耦；搜索初始化前构建，所有新增条目都可被搜索。
  const dailyGroup = node('section', 'help-group help-card');
  dailyGroup.append(node('h3', '', '摘取提交与更多日常操作'));
  const dailyCommands = [
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
  for (const [command, description] of dailyCommands) { const row = node('div', 'help-row'); row.append(commandButton(command), node('span', '', description)); dailyGroup.append(row); }
  const comparison = node('section', 'help-group help-card');
  comparison.append(node('h3', '', 'checkout、switch、restore 怎么选？'), node('p', 'help-note help-row', '切换分支：git checkout main 与 git switch main 对应；创建并切换：git checkout -b feature 与 git switch -c feature 对应。switch 专门管理分支切换，restore 专门恢复文件。checkout 兼有这两类用途；不能把所有 checkout 都直接替换成 switch。'));
  const reference = node('section', 'help-group help-card');
  reference.append(node('h3', '', '真实终端常用命令 · 仅供参考'), node('p', 'help-note', '以下写法依赖真实磁盘、网络、账号或更复杂的 Git 功能，网页不会执行。复制到自己的终端前替换占位符并核对目标；不会连接或修改你的真实仓库。'));
  const externalCommands = [
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
  for (const [command, description, page] of externalCommands) {
    const row = node('div', 'help-row help-reference-row'), code = node('code', 'command-chip', command);
    const detail = node('span', '', '仅供参考 · ' + description), link = node('a', '', '官方说明');
    link.href = 'https://git-scm.com/docs/' + page; link.target = '_blank'; link.rel = 'noopener noreferrer'; detail.append(document.createTextNode(' '), link);
    row.append(code, detail); reference.append(row);
  }
  const extraGrid = node('div', 'help-bento-grid help-expanded-grid'); extraGrid.append(dailyGroup, comparison, reference);
  const extraPanel = typeof helpPanels !== 'undefined' ? helpPanels.get('advanced') : $('help-content');
  extraPanel.append(extraGrid);
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
  $('file-editor').addEventListener('input', () => {
    if (editorMode === 'remote') { const session = remoteSession(); if (session) { session.buffer = $('file-editor').value; session.dirty = true; $('editor-status').textContent = '协作者草稿 · 执行命令时自动保存'; renderRecommendations(); } return; }
    dirty = true; $('editor-status').textContent = '编辑草稿 · 执行命令时自动保存'; renderRecommendations(); renderLesson();
  });
  $('save-file').addEventListener('click', () => saveEditor());
  $('file-select').addEventListener('change', () => {
    const target = $('file-select').value;
    if (editorMode === 'remote') { const session = remoteSession(); if (session.dirty && !saveRemoteEditor(true)) { $('file-select').value = session.selectedFile; return; } session.selectedFile = target; session.dirty = false; renderFiles(); message(); return; }
    if (dirty && !saveEditor(true)) { $('file-select').value = selectedFile; return; } selectedFile = target; dirty = false; message(); renderFiles();
  });
  $('delete-file').addEventListener('click', () => {
    try {
      if (editorMode === 'remote') { const session = remoteSession(); session.workspace.deleteFile(session.selectedFile); session.dirty = false; renderFiles(); message('已从协作者工作区删除，请暂存这次删除。'); return; }
      sim.deleteFile(selectedFile); dirty = false; renderFiles(); message('已从虚拟工作区删除。输入 git add 暂存这次删除。');
    } catch (error) { message(error.message, true); }
  });
  $('new-file').addEventListener('click', () => { $('new-file-form').hidden = false; $('new-path').focus(); });
  $('cancel-new').addEventListener('click', () => { $('new-file-form').hidden = true; });
  $('new-file-form').addEventListener('submit', event => {
    event.preventDefault();
    if (editorMode === 'remote') {
      const session = remoteSession(); if (!session || (session.dirty && !saveRemoteEditor(true))) return;
      const path = $('new-path').value.trim();
      try {
        if (session.workspace.fileStatus().some(file => file.path === path)) throw new Error('该文件已经存在，请从文件列表中选择。');
        session.workspace.editFile(path, ''); session.selectedFile = path; session.dirty = false; $('new-file-form').hidden = true; $('new-path').value = ''; renderFiles(); message('已在协作者工作区创建文件。'); $('file-editor').focus();
      } catch (error) { message(error.message, true); } return;
    }
    if (dirty && !saveEditor(true)) return;
    const path = $('new-path').value.trim();
    try {
      if (Object.hasOwn(sim.state.work, path)) throw new Error('工作区已有同名文件，请从文件列表中选择。');
      sim.editFile(path, ''); selectedFile = path; dirty = false; $('new-file-form').hidden = true; $('new-path').value = ''; renderFiles(); $('file-editor').focus(); message('已创建虚拟文件，请输入内容并保存。');
    } catch (error) { message(error.message, true); }
  });
  for (const [id, side] of [['use-ours', 'ours'], ['use-theirs', 'theirs']]) {
    $(id).addEventListener('click', () => {
      const session = editorMode === 'remote' ? remoteSession() : null, workspace = session?.workspace;
      const path = workspace ? session.selectedFile : selectedFile, repository = workspace || sim;
      const conflict = (workspace ? workspace.pending : sim.state.pending)?.conflicts[path]; if (!conflict) return;
      if (conflict[side] === null) { if (Object.hasOwn(workspace ? workspace.work : sim.state.work, path)) repository.deleteFile(path); }
      else repository.editFile(path, conflict[side]);
      if (session) session.dirty = false; else dirty = false;
      renderFiles(); message('已选择此版本，请检查内容，再 git add 并继续。');
    });
  }
  $('remote-branch').addEventListener('change', () => selectRemoteBranch($('remote-branch').value));
  $('remote-commit').addEventListener('click', () => {
    switchEditorMode('remote'); filePanel.scrollIntoView({ block: 'start' }); $('file-editor').focus();
    repositoryStatus.highlightCollaborator();
  });
  $('replay').addEventListener('click', replay); $('restart').addEventListener('click', () => loadScene(sim.scene));
  $('help-button').addEventListener('click', () => $('help-dialog').showModal()); $('close-help').addEventListener('click', () => $('help-dialog').close());
  $('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const rect = $('help-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('help-dialog').close(); } });
  document.addEventListener('keydown', event => { if (event.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('help-dialog').open && !graphViewer.dialog.open) $('help-dialog').showModal(); });
  $('zoom-in').addEventListener('click', () => graph.setZoom(graph.zoom + .2)); $('zoom-out').addEventListener('click', () => graph.setZoom(graph.zoom - .2)); $('zoom-reset').addEventListener('click', () => graph.setZoom(1));
  window.addEventListener('resize', () => graph.resize());
  loadScene('basic');
})();

/* 搜索只筛选手册原节点，保留示例按钮的填入与变量选中行为。 */
(function () {
  'use strict';

  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

  /** 省略字符仍按原顺序匹配；英文长词额外容忍一次编辑或相邻字母颠倒，避免短词过度匹配。 */
  function fuzzyWord(term, word) {
    let index = 0;
    for (const char of word) if (char === term[index]) index++;
    if (index === term.length) return true;
    if (!/^[a-z-]{4,}$/.test(term) || !/^[a-z-]{4,}$/.test(word) || Math.abs(term.length - word.length) > 1) return false;
    let previous = Array.from({ length: word.length + 1 }, (_, i) => i), beforePrevious;
    for (let i = 1; i <= term.length; i++) {
      const row = [i];
      for (let j = 1; j <= word.length; j++) {
        row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (term[i - 1] === word[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && term[i - 1] === word[j - 2] && term[i - 2] === word[j - 1]) row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
      }
      beforePrevious = previous; previous = row;
    }
    return previous[word.length] <= 1;
  }

  const dialog = document.getElementById('help-dialog'), content = document.getElementById('help-content');
  const groups = [...content.querySelectorAll('.help-group')].map(element => ({
    element,
    entries: [...element.querySelectorAll('.help-row, .help-flow')].map(item => {
      const text = normalize((element.querySelector('h3')?.textContent || '') + ' ' + item.textContent);
      return { element: item, text, words: text.match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) || [] };
    })
  }));
  const containers = [...content.querySelectorAll('.help-panel, .help-bento-col')];
  const tabs = [...content.querySelectorAll('.help-tabs')];
  let saved = null;

  const bar = document.createElement('div'); bar.className = 'help-search';
  const label = document.createElement('label'); label.htmlFor = 'help-search-input'; label.textContent = '搜索手册';
  const controls = document.createElement('div'); controls.className = 'help-search-controls';
  const input = document.createElement('input');
  input.id = 'help-search-input'; input.type = 'search'; input.autofocus = true; input.autocomplete = 'off'; input.maxLength = 160;
  input.placeholder = '模糊搜索命令或中文说明，如 rbase、取消暂存';
  input.setAttribute('aria-controls', 'help-content'); input.setAttribute('aria-describedby', 'help-search-status');
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'button quiet small'; clear.textContent = '清空';
  const status = document.createElement('p'); status.id = 'help-search-status'; status.className = 'help-search-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  controls.append(input, clear); bar.append(label, controls, status); content.before(bar);

  /** 搜索覆盖全部分类；退出搜索时恢复原来的分类、可见性和滚动位置。 */
  function filter() {
    const terms = normalize(input.value).split(' ').filter(Boolean);
    clear.disabled = input.value.length === 0;
    if (!terms.length) {
      if (saved) {
        for (const [element, hidden] of saved.visibility) element.hidden = hidden;
        dialog.classList.remove('help-search-active'); dialog.scrollTop = saved.scrollTop; saved = null;
      }
      status.textContent = '支持命令片段、漏字母与错字模糊匹配；多个关键词用空格分隔。';
      return;
    }
    if (!saved) {
      const elements = [...tabs, ...containers, ...groups.flatMap(group => [group.element, ...group.entries.map(entry => entry.element)])];
      saved = { visibility: new Map(elements.map(element => [element, element.hidden])), scrollTop: dialog.scrollTop };
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
      group.element.hidden = matches === 0; count += matches;
    }
    for (const element of containers) element.hidden = ![...element.querySelectorAll('.help-group')].some(group => !group.hidden);
    for (const element of tabs) element.hidden = true;
    status.textContent = count ? '找到 ' + count + ' 条相关命令与流程 · 全部分类 · 模糊匹配' : '没有找到匹配内容，试试命令片段或更短的中文关键词。';
  }

  input.addEventListener('input', filter);
  clear.addEventListener('click', () => { input.value = ''; filter(); input.focus(); });
  input.addEventListener('keydown', event => {
    // 输入法选字期间不拦截 Esc；有搜索词时先清空，再次 Esc 交给原生弹窗关闭。
    if (event.key === 'Escape' && input.value && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); event.stopPropagation(); input.value = ''; filter();
    }
  });
  filter();
})();
