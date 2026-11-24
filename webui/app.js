(function () {
  'use strict';

  const { Simulator, RemoteWorkspace, SCENES, ACTORS: roles, edits, hasConflictMarkers } = GitSimulator;
  const integrationHint = '以 dev 为例，先 fetch，切到 dev 并合入 origin/dev，再逐一合入已发布的功能分支，最后 push。';
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };

  const sim = new Simulator();
  let lesson = new GitLessons.Practice(sim.scene, sim.snapshot());
  let selectedFile = 'hello.txt';
  let selectedCommit = null;
  let dirty = false;
  let history = [];
  let historyIndex = 0;
  let draft = '';
  let remoteBranch = null;
  let editorMode = 'local';
  let localBuffer = '';
  let remoteSessions = new Map();
  let resetUndo = null;

  let commandSessions = new Map();
  const commandHistory = new GitTerminalHistory.History();
  const filePanel = $('files-title').closest('.files-panel');
  const graph = new CommitGraph($('graph'), showCommit);

  const replayStatus = node('p', 'replay-status');
  replayStatus.id = 'replay-status';
  replayStatus.hidden = true;
  replayStatus.setAttribute('role', 'status');
  $('explanation').after(replayStatus);

  const replayController = new GitReplay.ReplayController({
    button: $('replay'),
    stage: $('graph-stage'),
    status: replayStatus,
    flow: $('flow'),
    filePanel,
    graph,
    getState: graphState,
    animateFiles
  });
  const cancelReplay = () => replayController.cancel();

  const graphViewer = new GitGraphViewer(
    graph,
    $('graph-stage'),
    () => ({
      state: graphState(),
      title: SCENES[sim.scene].title + ' · ' + roles[editorMode].terminal
    }),
    cancelReplay
  );
  const assistant = new GitCommandAssist.Controller($('command'), assistContext);
  const lessonView = new GitLessons.View(
    $('graph-stage'),
    (command, actor) => {
      if (switchEditorMode(actor)) fillCommand(command);
    },
    route => {
      lesson.route = route;
      renderLesson();
    }
  );
  const repositoryBrowser = new GitRepositoryBrowser.View(() => ({ state: graphState(), actor: editorMode }), cancelReplay);
  const repositoryStatus = new GitRepositoryStatus.StatusView(filePanel, fillCommand);
  const remoteSync = new GitRepositoryStatus.SyncView($('remote-sync'));

  const labels = [
    '编辑与提交',
    '分叉与汇合',
    '解决同一行冲突',
    '改变提交的基点',
    '理解三种模式',
    '本地与远程同步',
    '保存与恢复改动',
    '摘取、撤回与找回',
    '双仓库并发协作'
  ];

  // 两处身份按钮共用切换入口，确保终端和编辑区始终操作同一个仓库。
  function addRoleButtons(group, prefix, className = '') {
    return Object.entries(roles).map(([actor, role]) => {
      const button = node('button', className, role.button);
      button.type = 'button';
      button.id = prefix + '-' + actor;
      button.addEventListener('click', () => switchEditorMode(actor));
      group.append(button);
      return [actor, button];
    });
  }

  function updateRoleButtons(buttons) {
    for (const [actor, button] of buttons) {
      button.setAttribute('aria-pressed', String(actor === editorMode));
      button.disabled = actor !== 'local' && !remoteSessions.has(actor);
      button.title = button.disabled ? '共享远程有分支后可切换到该身份' : '';
    }
  }

  const terminalContext = node('div', 'terminal-context');
  const terminalModes = node('div', 'terminal-modes');
  terminalModes.setAttribute('role', 'group');
  terminalModes.setAttribute('aria-label', '选择命令执行身份');
  const terminalRoleButtons = addRoleButtons(terminalModes, 'terminal');

  const terminalBranchLabel = node('label', 'terminal-branch');
  const terminalBranchCaption = node('span');
  const terminalBranch = node('select');
  terminalBranch.id = 'terminal-branch';
  terminalBranchLabel.htmlFor = terminalBranch.id;
  terminalBranch.addEventListener('change', () => selectRemoteBranch(terminalBranch.value));
  terminalBranchLabel.append(terminalBranchCaption, terminalBranch);

  const terminalScope = node('p', 'terminal-scope');
  terminalScope.id = 'terminal-scope';
  terminalScope.setAttribute('role', 'status');
  terminalContext.append(terminalModes, terminalBranchLabel, terminalScope);
  $('terminal').before(terminalContext);

  const historyCopy = new GitTerminalHistory.View(terminalContext, commandHistory, () => ({
    actor: editorMode,
    scene: SCENES[sim.scene].title
  }));
  $('terminal').closest('.command-panel').classList.add('has-terminal-context');
  $('command').setAttribute('aria-describedby', $('command').getAttribute('aria-describedby') + ' terminal-scope');

  // 文件区身份切换、协作者工具栏及提交按钮区
  const modeBar = node('div', 'editor-mode-bar');
  modeBar.setAttribute('role', 'group');
  modeBar.setAttribute('aria-label', '选择文件编辑身份');
  const editorRoleButtons = addRoleButtons(modeBar, 'editor', 'button quiet small');
  $('new-file-form').before(modeBar);

  const remoteToolbar = node('div', 'remote-editor-toolbar');
  const remoteBranchLabel = node('label', '', '协作者本地分支');
  remoteBranchLabel.htmlFor = 'editor-remote-branch';
  const remoteBranchSelect = node('select');
  remoteBranchSelect.id = 'editor-remote-branch';
  remoteBranchSelect.addEventListener('change', () => selectRemoteBranch(remoteBranchSelect.value));
  const reloadRemote = node('button', 'button quiet small', '获取远程（fetch）');
  reloadRemote.type = 'button';
  reloadRemote.title = '获取远程最新历史和 origin/* 引用，保留当前身份的本地分支与文件';
  reloadRemote.addEventListener('click', () => runRemoteAction('git fetch origin'));
  const remoteBase = node('p', 'remote-editor-base');
  remoteBase.id = 'remote-editor-base';
  remoteBase.setAttribute('role', 'status');
  remoteToolbar.append(remoteBranchLabel, remoteBranchSelect, reloadRemote, remoteBase);
  modeBar.after(remoteToolbar);

  const remoteActions = node('div', 'remote-editor-actions');
  const remoteMessageLabel = node('label', '', '协作者提交说明');
  remoteMessageLabel.htmlFor = 'remote-message';
  const remoteMessage = node('input');
  remoteMessage.id = 'remote-message';
  remoteMessage.maxLength = 200;
  remoteMessage.placeholder = '例如：调整 dev 分支的问候语';
  remoteMessage.addEventListener('input', () => {
    const session = remoteSession();
    if (session) session.message = remoteMessage.value;
  });
  const stageRemoteFile = node('button', 'button quiet small', '暂存当前文件');
  const stageRemoteAll = node('button', 'button quiet small', '暂存全部');
  const submitRemote = node('button', 'button primary small', '提交（commit）');
  const pushRemote = node('button', 'button primary small', '推送（push）');
  stageRemoteFile.type = stageRemoteAll.type = submitRemote.type = pushRemote.type = 'button';
  stageRemoteFile.id = 'remote-stage-file';
  stageRemoteAll.id = 'remote-stage-all';
  submitRemote.id = 'remote-submit';
  pushRemote.id = 'remote-push';
  stageRemoteFile.addEventListener('click', () => stageRemote(false));
  stageRemoteAll.addEventListener('click', () => stageRemote(true));
  submitRemote.addEventListener('click', commitRemoteEditor);
  pushRemote.addEventListener('click', () => {
    const workspace = remoteSession()?.workspace;
    if (workspace?.branch) {
      runRemoteAction(workspace.upstreams[workspace.branch] ? 'git push' : 'git push -u origin ' + JSON.stringify(workspace.branch));
    }
  });
  const remoteCommandHint = node('p', 'remote-command-hint');
  remoteActions.append(remoteMessageLabel, remoteMessage, stageRemoteFile, stageRemoteAll, submitRemote, pushRemote, remoteCommandHint);
  $('file-message').before(remoteActions);

  /** 共享远程首次有分支时初始化各辅助仓库。已初始化的仓库由各身份自行 fetch。 */
  function initializeRemoteSessions() {
    const { branches, commits } = sim.state.remote;
    const branch = Object.hasOwn(branches, 'main') ? 'main' : Object.keys(branches)[0];
    if (!branch) return;
    for (const actor of Object.keys(roles)) {
      if (actor === 'local' || remoteSessions.has(actor)) continue;
      const workspace = new RemoteWorkspace(branch, commits[branches[branch]], sim.state.remote, actor);
      remoteSessions.set(actor, {
        workspace,
        selectedFile: Object.hasOwn(workspace.work, 'hello.txt') ? 'hello.txt' : Object.keys(workspace.work)[0] || '',
        dirty: false,
        buffer: '',
        message: ''
      });
    }
  }

  function remoteSession() {
    if (editorMode === 'local') return null;
    return remoteSessions.get(editorMode);
  }

  function localEditorText() {
    return editorMode === 'local' ? $('file-editor').value : localBuffer;
  }

  /** 当前身份决定提交图来源；协作者未 push 的提交不进入“我的本地”或共享远程。 */
  function graphState() {
    return remoteSession()?.workspace.commandContext(sim).state || sim.state;
  }

  function syncZoomButtons() {
    $('zoom-out').disabled = !graph.canZoomOut;
    $('zoom-in').disabled = !graph.canZoomIn;
  }

  function selectRemoteBranch(branch) {
    if (branch && branch !== remoteSession()?.workspace.branch) {
      runRemoteAction('git switch ' + JSON.stringify(branch));
    } else {
      render();
    }
  }

  function captureTerminalSession() {
    return {
      history,
      historyIndex,
      draft,
      input: $('command').value,
      entries: [...$('terminal').childNodes],
      scroll: $('terminal').scrollTop
    };
  }

  function restoreTerminalSession(session) {
    history = session.history;
    historyIndex = session.historyIndex;
    draft = session.draft;
    $('command').value = session.input;
    $('terminal').replaceChildren(...session.entries);
    $('terminal').scrollTop = session.scroll;
  }

  /** 返回是否已选中目标身份。辅助仓库尚未初始化时保留当前身份及草稿。 */
  function switchEditorMode(mode = 'local') {
    if (mode === editorMode) return true;
    if (mode !== 'local' && !remoteSessions.has(mode)) return false;
    replayController.reset();
    selectedCommit = null;
    $('commit-detail').open = false;
    $('commit-summary').textContent = '选择一个提交，查看它的文件快照';
    $('commit-content').replaceChildren();
    commandSessions.set(editorMode, captureTerminalSession());
    if (editorMode === 'local') localBuffer = $('file-editor').value;
    editorMode = mode;
    $('new-file-form').hidden = true;
    if (mode === 'local') $('file-editor').value = localBuffer;
    restoreTerminalSession(commandSessions.get(mode) || {
      history: [], historyIndex: 0, draft: '', input: '', scroll: 0,
      entries: [
        node('div', 'welcome-title', roles[mode].button + '命令终端'),
        node('p', 'terminal-welcome', mode === 'integrator' ? integrationHint : '编辑后依次 add、commit、push。commit 保存到协作者本地；push 后共享远程才更新。')
      ]
    });
    message();
    render();
    return true;
  }

  /** 明示命令目标，编辑区与终端使用同一个身份，避免对另一方的文件执行命令。 */
  function renderTerminalContext() {
    const remote = editorMode !== 'local';
    const role = roles[editorMode];
    updateRoleButtons(terminalRoleButtons);
    terminalContext.classList.toggle('is-remote', remote);
    terminalContext.classList.toggle('is-integrator', editorMode === 'integrator');
    terminalBranchLabel.hidden = !remote;
    terminalBranchCaption.textContent = role.owner + '分支';
    const branch = remote ? remoteBranch : sim.state.head.branch;
    const hint = editorMode === 'integrator' ? '合并前确认当前分支是接收改动的目标。' : 'commit 后需 push 才会更新虚拟远程。';
    terminalScope.textContent = '当前操作：' + role.terminal + ' · ' + (branch || '分离 HEAD') + '。' + hint;
    $('command').placeholder = editorMode === 'integrator' ? '输入合并命令，如 git fetch origin' : '输入 Git 命令，如 git status';
    historyCopy.update();
    assistant.refresh(false);
  }

  function saveRemoteEditor(quiet = false) {
    const session = remoteSession();
    if (!session || !session.selectedFile) return false;
    try {
      session.workspace.editFile(session.selectedFile, $('file-editor').value);
      session.dirty = false;
      renderFiles();
      if (!quiet) message('已保存到' + roles[editorMode].owner + '工作区。');
      return true;
    } catch (error) {
      message(error.message, true);
      return false;
    }
  }

  function stageRemote(all) {
    const session = remoteSession();
    if (session) runRemoteAction('git add ' + (all ? '.' : JSON.stringify(session.selectedFile)));
  }

  function commitRemoteEditor() {
    const session = remoteSession();
    if (!session) return;
    if (!session.message.trim()) {
      message('请填写提交说明。', true);
      remoteMessage.focus();
      return;
    }
    runRemoteAction('git commit -m ' + JSON.stringify(session.message));
  }

  /** 按钮与命令行复用相同执行入口，避免按钮提交和终端提交出现不同语义。 */
  function runRemoteAction(command) {
    const session = remoteSession();
    if (!session || (session.dirty && !saveRemoteEditor(true))) return;
    const branch = session.workspace.branch;
    cancelReplay();
    const result = session.workspace.execute(sim, command);
    const changed = Boolean(result.ok || result.fetchCompleted);
    lesson.record(result);
    terminalEntry(command, result.output, result, editorMode, branch);
    if (result.ok && result.command.name === 'commit') session.message = '';
    if (result.ok && result.conflict) session.selectedFile = session.workspace.pending.unresolved[0];
    render(changed);
    updateExplanation(result, command);
    if (changed) {
      replayController.setResult(result);
      if (result.commitId) showCommit(session.workspace.commits[result.commitId], false);
    }
    message(result.ok ? result.explanation : result.output, !result.ok);
  }

  /** 草稿也参与下一步推荐，但读取建议本身不会保存文件或改变虚拟仓库。 */
  function localAssistContext() {
    const files = sim.fileStatus().map(file => ({ ...file }));
    let state = sim.state;
    if (dirty && selectedFile) {
      const file = files.find(item => item.path === selectedFile);
      if (file) file.unstaged = localEditorText() !== sim.state.index[selectedFile];
      state = { ...sim.state, work: { ...sim.state.work, [selectedFile]: localEditorText() } };
    }
    return { state, files, scene: sim.scene };
  }

  function assistContext() {
    if (editorMode === 'local') return localAssistContext();
    const session = remoteSession();
    if (!session) return { ...localAssistContext(), mode: editorMode, files: [], stale: true };
    const context = session.workspace.commandContext(sim);
    if (session.dirty && session.selectedFile) {
      context.state.work[session.selectedFile] = session.buffer;
      const file = context.files.find(item => item.path === session.selectedFile);
      if (file) file.unstaged = session.buffer !== context.state.index[session.selectedFile];
    }
    return context;
  }

  function renderRecommendations() {
    const rows = GitCommandAssist.recommend(assistContext());
    $('quick-commands').replaceChildren(
      ...rows.map(({ command, description }) => {
        const button = node('button', 'command-chip recommended-command');
        button.type = 'button';
        button.append(node('code', '', command), node('small', '', description));
        button.addEventListener('click', () => {
          fillCommand(command);
          const pos = command.indexOf('说明本次修改');
          if (pos >= 0) $('command').setSelectionRange(pos, pos + '说明本次修改'.length);
        });
        return button;
      })
    );
    const title = document.querySelector('.suggestions .small-label');
    title.replaceChildren(
      document.createTextNode('接下来可以试试 '),
      node('span', '', '按' + (editorMode === 'local' ? '本地' : roles[editorMode].owner) + '状态推荐 · 点击填入')
    );
  }

  /** 草稿参与验收但不写入仓库，防止未保存编辑仍显示全部完成。 */
  function renderLesson() {
    lessonView.update(lesson, localAssistContext().state, dirty);
  }

  /** 命令状态取自实际执行结果；用户文本只进入文本节点，不拼接 HTML。 */
  function terminalEntry(command, output, result, actor, branch) {
    commandHistory.record({ actor, branch, scene: SCENES[sim.scene].title, command, output, result });
    historyCopy.update();
    const entry = node('div', 'terminal-entry');
    const commandLine = node(
      'div',
      'terminal-command',
      '[' + roles[actor].terminal + ' · ' + (branch || '分离 HEAD') + '] $ ' + command
    );
    const type = !result ? '' : !result.ok ? 'terminal-error' : result.conflict || result.paused ? 'terminal-conflict' : '';
    if (result) {
      const status = !result.ok
        ? ['error', '✕ 失败']
        : result.conflict
          ? ['conflict', '⚠ 待解决冲突']
          : result.paused
            ? ['conflict', '⚠ 已暂停']
            : ['success', '✓ 成功'];
      commandLine.append(node('span', 'terminal-command-status terminal-command-' + status[0], status[1]));
    }
    entry.append(commandLine, node('pre', 'terminal-output ' + type, output));
    $('terminal').append(entry);
    while ($('terminal').children.length > 80) $('terminal').firstElementChild.remove();
    $('terminal').scrollTop = $('terminal').scrollHeight;
  }

  function message(text = '', error = false) {
    $('file-message').textContent = text;
    $('file-message').classList.toggle('error', error);
  }

  function fillCommand(command) {
    $('command').value = command;
    $('command').focus();
    $('command').setSelectionRange(command.length, command.length);
    assistant.refresh(false);
  }

  /** 场景与页面生命周期共用清理入口，同时清空各身份的日志、上下键历史和未执行输入。 */
  function clearCommandHistory() {
    commandSessions = new Map();
    history = [];
    historyIndex = 0;
    draft = '';
    commandHistory.clear();
    historyCopy.reset();
    $('terminal').replaceChildren();
    $('terminal').scrollTop = 0;
    $('command').value = '';
    assistant.refresh(false);
  }

  function setResetUndo(snapshot, announcement = '') {
    resetUndo = snapshot;
    $('undo-restart').disabled = !snapshot;
    $('scene-reset-status').textContent = announcement;
  }

  /** 重置会换用新的仓库、验收与终端容器。旧对象留给当前场景的一次撤销。 */
  function restartScene() {
    const snapshot = {
      state: sim.state,
      lesson,
      editorMode,
      selectedFile,
      selectedCommit,
      commitOpen: $('commit-detail').open,
      dirty,
      localBuffer: localEditorText(),
      remoteSessions,
      newFileOpen: !$('new-file-form').hidden,
      newPath: $('new-path').value,
      commandSessions,
      terminal: captureTerminalSession(),
      commandEntries: commandHistory.entries,
      replayResult: replayController.lastResult,
      explanationTitle: $('explanation-title').textContent,
      explanation: $('explanation').textContent,
      flow: [...$('flow').childNodes]
    };
    loadScene(sim.scene);
    setResetUndo(snapshot, '场景已重置。可以撤销本次重置。');
  }

  /** 直接恢复虚拟练习状态，包含未提交改动、暂停的操作和各身份的草稿。 */
  function undoRestart() {
    if (!resetUndo) return;
    const snapshot = resetUndo;
    replayController.reset();
    sim.state = snapshot.state;
    ({ lesson, editorMode, selectedFile, selectedCommit, dirty, localBuffer, remoteSessions, commandSessions } = snapshot);
    if (editorMode === 'local') $('file-editor').value = localBuffer;
    $('commit-detail').open = snapshot.commitOpen;
    $('commit-summary').textContent = '选择一个提交，查看它的文件快照';
    $('commit-content').replaceChildren();
    $('new-file-form').hidden = !snapshot.newFileOpen;
    $('new-path').value = snapshot.newPath;
    restoreTerminalSession(snapshot.terminal);
    commandHistory.entries = snapshot.commandEntries;
    historyCopy.reset();
    $('explanation-title').textContent = snapshot.explanationTitle;
    $('explanation').textContent = snapshot.explanation;
    $('flow').replaceChildren(...snapshot.flow);
    replayController.setResult(snapshot.replayResult);
    message();
    render();
    setResetUndo(null, '已恢复重置前的练习。');
    $('restart').focus({ preventScroll: true });
  }

  function loadScene(scene) {
    setResetUndo(null);
    const previousRoute = lesson.scene === scene ? lesson.route : undefined;
    replayController.reset();
    sim.loadScene(scene);
    selectedFile = 'hello.txt';
    selectedCommit = null;
    remoteBranch = null;
    dirty = false;
    editorMode = 'local';
    localBuffer = '';
    remoteSessions = new Map();
    clearCommandHistory();
    repositoryBrowser.reset();
    remoteSync.reset();
    lesson = new GitLessons.Practice(scene, sim.snapshot(), previousRoute);
    graph.previous = new Map();
    graph.previousTags = new Map();

    const info = SCENES[scene];
    const keys = Object.keys(SCENES);
    const index = keys.indexOf(scene);
    const total = String(keys.length).padStart(2, '0');
    $('scene-number').textContent = '场景 ' + String(index + 1).padStart(2, '0') + ' / ' + total;
    $('scene-title').textContent = info.title;
    $('scene-subtitle').textContent = info.subtitle;
    document.querySelectorAll('.scene-button').forEach(button => {
      const active = button.dataset.scene === scene;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    $('terminal').replaceChildren(
      node('div', 'welcome-title', '欢迎来到 ' + info.title + '。'),
      node('p', 'terminal-welcome', info.hint)
    );
    $('explanation-title').textContent = '观察起点，再试一条命令';
    $('explanation').textContent = info.hint;
    $('flow').replaceChildren();
    $('command').value = '';
    $('commit-detail').open = false;
    $('commit-summary').textContent = '选择一个提交，查看它的文件快照';
    $('commit-content').replaceChildren();
    $('new-file-form').hidden = true;
    $('new-path').value = '';
    assistant.refresh(false);
    message();
    render();
  }

  function render(animate = false) {
    initializeRemoteSessions();
    renderRemote();
    const state = graphState();
    const prefix = editorMode === 'local' ? '' : roles[editorMode].owner + ' · ';
    $('head-label').textContent = prefix + (state.head.branch || '分离 · ' + state.head.id);
    graph.draw(state, { animate });
    syncZoomButtons();
    renderFiles();
    if (selectedCommit) {
      const commit = state.commits[selectedCommit] || state.remote.commits[selectedCommit];
      if (commit) showCommit(commit, !Object.hasOwn(state.commits, selectedCommit));
    }
  }

  function renderRemote() {
    const session = remoteSession();
    const workspace = session?.workspace;
    const branches = workspace ? [...new Set([...Object.keys(workspace.branches), ...Object.keys(workspace.tracking)])].sort() : [];
    remoteBranch = workspace?.branch || null;
    const options = branches.map(branch => {
      const option = node('option', '', branch + (Object.hasOwn(workspace.branches, branch) ? '' : '（跟踪 origin/' + branch + '）'));
      option.value = branch;
      return option;
    });
    if (!remoteBranch) {
      const option = node('option', '', workspace ? '分离 HEAD · ' + workspace.baseId : '暂无远程分支');
      option.value = '';
      option.disabled = true;
      options.unshift(option);
    }
    terminalBranch.replaceChildren(...options);
    terminalBranch.value = remoteBranch || '';
    terminalBranch.disabled = !branches.length;
    remoteBranchSelect.replaceChildren(...options.map(option => option.cloneNode(true)));
    remoteBranchSelect.value = remoteBranch || '';
    remoteBranchSelect.disabled = !branches.length;
    remoteSync.update(graphState(), editorMode);
  }

  /** 暂存区以 HEAD 为基准展示行级增删；删除的文件仍保留在可选列表中。 */
  function renderCode(container, text, baseline, showDiff = false) {
    container.replaceChildren();
    if (text === undefined && (!showDiff || baseline === undefined)) {
      container.append(node('span', 'empty-file', '此区域没有该文件'));
      return;
    }
    const baseLines = (baseline || '').match(/[^\n]*\n|[^\n]+$/g) || [];
    const changes = showDiff ? edits(baseline, text) : [];
    let cursor = 0;
    const line = (content, type, number) => {
      const row = node('span', 'code-line' + (type ? ' ' + type : ''));
      row.append(
        node('span', 'line-prefix', type === 'added' ? '+' : type === 'removed' ? '−' : String(number)),
        document.createTextNode(content.replace(/\n$/, ''))
      );
      container.append(row);
    };
    if (!changes.length) {
      const content = (text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
      if (!content.length) container.append(node('span', 'empty-file', text === undefined ? '此区域没有该文件' : '空文件'));
      content.forEach((contentLine, i) => line(contentLine, '', i + 1));
      return;
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
    const remote = editorMode !== 'local';
    const { button, owner, terminal } = roles[editorMode];
    updateRoleButtons(editorRoleButtons);
    filePanel.classList.toggle('editing-remote', remote);
    filePanel.classList.toggle('editing-integrator', editorMode === 'integrator');
    remoteToolbar.hidden = !remote;
    remoteActions.hidden = !remote;
    $('files-title').replaceChildren(
      node('span', 'section-dot green'),
      document.createTextNode('文件与三个区域 · ' + button)
    );

    const indexArea = $('index-file').closest('.area');
    const headArea = $('head-file').closest('.area');
    document.querySelector('.work-area .area-heading > span').textContent = remote ? 'WORKTREE · ' + owner + '编辑' : 'WORKTREE · 直接编辑';
    indexArea.querySelector('.area-heading > span').textContent = remote ? 'INDEX · ' + owner + '暂存快照' : 'INDEX · git add 快照';
    headArea.querySelector('.area-heading > span').textContent = remote ? owner + ' HEAD · ' + (remoteBranch || '') : 'HEAD · 已提交快照';
    indexArea.querySelector('.area-footer').textContent = '相对 HEAD：绿色为新增，红色为删除';
    headArea.querySelector('.area-footer').textContent = remote
      ? terminal + '最近一次提交；push 后才发布到共享远程'
      : '最近一次 git commit 保存的内容';

    if (!remote) {
      renderLocalFiles();
      return;
    }

    const session = remoteSession();
    if (!session) {
      $('file-editor').value = '';
      $('file-editor').disabled = true;
      submitRemote.disabled = pushRemote.disabled = reloadRemote.disabled = true;
      remoteBase.textContent = '暂无远程分支，请先切回本地 push。';
      return;
    }
    remoteBranchLabel.textContent = owner + '本地分支';
    remoteMessageLabel.textContent = owner + '提交说明';
    remoteMessage.placeholder = editorMode === 'integrator'
      ? '例如：解决订单和购物车的合并冲突'
      : '例如：调整 dev 分支的问候语';
    remoteCommandHint.textContent = editorMode === 'integrator'
      ? '合并遇到冲突时，在此编辑冲突文件并暂存，再在终端执行 git merge --continue。'
      : '编辑 → add 暂存 → commit 保存到协作者本地 → push 发布到共享远程。';

    const workspace = session.workspace;
    const files = workspace.fileStatus();
    const paths = files.map(file => file.path);
    if (!paths.includes(session.selectedFile)) session.selectedFile = paths[0] || '';
    const path = session.selectedFile;
    const status = files.find(file => file.path === path);
    $('file-select').replaceChildren(
      ...paths.map(item => {
        const option = node('option', '', item);
        option.value = item;
        return option;
      })
    );
    $('file-select').value = path;
    $('file-select').disabled = !path;

    const readFile = tree => (Object.hasOwn(tree, path) ? tree[path] : undefined);
    const work = session.dirty ? session.buffer : readFile(workspace.work);
    $('file-editor').value = work ?? '';
    $('file-editor').disabled = !path;
    $('save-file').disabled = !path;
    $('delete-file').disabled = !Object.hasOwn(workspace.work, path);
    renderCode($('head-file'), readFile(workspace.base));
    renderCode($('index-file'), readFile(workspace.index), readFile(workspace.base), true);
    renderCode($('work-diff'), work, readFile(workspace.index), true);

    $('file-state').replaceChildren(node('span', '', path || '暂无文件'));
    if (status?.conflict) $('file-state').append(node('span', 'state-tag conflict', '冲突待解决'));
    if (status?.staged) $('file-state').append(node('span', 'state-tag', '已暂存'));
    if (session.dirty || status?.unstaged) {
      $('file-state').append(
        node('span', 'state-tag dirty', session.dirty ? '草稿未保存' : status.deleted ? '工作区删除' : '未暂存')
      );
    } else if (!status?.staged && !status?.conflict) {
      $('file-state').append(node('span', 'state-tag', '三个区域一致'));
    }
    renderFileMarkerNotice(work);
    $('editor-status').textContent = session.dirty ? owner + '草稿 · 执行命令时自动保存' : '编辑后保存到' + owner + '工作区';

    const context = workspace.commandContext(sim);
    const pending = workspace.pending;
    // 领先和落后数量只在仓库状态栏按本地 origin/* 显示。此处提示尚未获取的共享远程更新。
    const needsFetch = Boolean(context.upstream && context.actual !== workspace.tracking[context.upstream]);
    let guidance;
    if (pending?.type === 'stash') guidance = 'stash 恢复冲突：编辑后 add，记录仍保留。';
    else if (pending) guidance = '正在 ' + pending.type + '：解决冲突并暂存后执行 ' + pending.type + ' --continue，也可 --abort。';
    else if (!remoteBranch) guidance = '可用 switch -c 新分支保存提交。';
    else if (!context.upstream) guidance = '未设置上游，可以推送并关联当前分支。';
    else if (needsFetch) guidance = '共享远程有更新，请先 fetch。';
    else if (context.behind) guidance = '请先把上游的改动合入当前分支。';
    else if (context.ahead) guidance = '有尚未发布的提交，点击“推送”发布。';
    else guidance = '与共享远程同步。';
    remoteBase.textContent =
      terminal + ' · ' +
      (remoteBranch || '分离 HEAD') +
      ' · ' +
      workspace.baseId +
      ' ｜' +
      (context.actual
        ? '共享远程分支 ' + (context.upstream || remoteBranch) + ' · ' + context.actual
        : '当前分支尚未发布') + '。' + guidance;
    remoteBase.classList.toggle('error', Boolean(needsFetch || context.behind || pending));
    stageRemoteFile.disabled = !path;
    stageRemoteAll.disabled = !files.length;
    submitRemote.disabled = Boolean(pending) || !files.some(file => file.staged);
    pushRemote.disabled = Boolean(pending) || !remoteBranch || (Boolean(context.upstream) && !context.ahead);
    pushRemote.textContent = context.upstream ? '推送到远程 ' + context.upstream : '推送并关联 ' + (remoteBranch || '分支');
    reloadRemote.disabled = Boolean(pending);
    remoteMessage.value = session.message;
    renderConflict(context.state, path);
    renderRecommendations();
    renderLesson();
  }

  function renderLocalFiles() {
    const files = sim.fileStatus();
    const paths = files.map(file => file.path);
    if (!paths.includes(selectedFile)) selectedFile = paths[0] || '';
    $('file-select').replaceChildren(
      ...paths.map(path => {
        const option = node('option', '', path);
        option.value = path;
        return option;
      })
    );
    $('file-select').value = selectedFile;
    $('file-select').disabled = !paths.length;

    const state = files.find(file => file.path === selectedFile);
    const head = sim.headTree()[selectedFile];
    const index = sim.state.index[selectedFile];
    const work = sim.state.work[selectedFile];
    renderCode($('head-file'), head);
    renderCode($('index-file'), index, head, true);
    if (!dirty) $('file-editor').value = work ?? '';
    $('file-editor').disabled = !selectedFile;
    $('save-file').disabled = !selectedFile;
    $('delete-file').disabled = !selectedFile || work === undefined;
    $('editor-status').textContent = dirty ? '编辑草稿尚未保存' : work === undefined ? '工作区已删除 · 保存可恢复' : '编辑后保存到工作区';

    $('file-state').replaceChildren();
    if (state) {
      $('file-state').append(node('span', '', selectedFile));
      if (state.conflict) $('file-state').append(node('span', 'state-tag conflict', '冲突待解决'));
      else if (!state.staged && !state.unstaged) $('file-state').append(node('span', 'state-tag', '三个区域一致'));
      if (state.staged) $('file-state').append(node('span', 'state-tag', '已暂存'));
      if (state.untracked) $('file-state').append(node('span', 'state-tag dirty', '未跟踪'));
      else if (state.unstaged) $('file-state').append(node('span', 'state-tag dirty', state.deleted ? '工作区删除' : '未暂存改动'));
      renderFileMarkerNotice(dirty ? localEditorText() : work);
    }

    renderConflict(sim.state, selectedFile);
    renderCode($('work-diff'), work, index, true);
    renderRecommendations();
    renderLesson();
  }

  /** 警告与工作区草稿同步显示，暂存状态仍由引擎判断。 */
  function renderFileMarkerNotice(text) {
    const label = $('file-state');
    const warning = label.querySelector('.file-marker-warning');
    if (hasConflictMarkers(text)) {
      if (!warning) label.append(node('span', 'state-tag conflict file-marker-warning', '仍有冲突标记，请检查'));
    } else {
      warning?.remove();
    }
  }

  /** 两个身份共用冲突解释，版本选择按钮仅改动当前身份的工作区。 */
  function renderConflict(state, path) {
    const conflict = state.pending?.conflicts[path];
    $('conflict-panel').hidden = !conflict;
    if (conflict) {
      const op = state.pending;
      $('conflict-title').textContent = op.unresolved.includes(path) ? '冲突待解决 · ' + path : '已暂存解决结果 · ' + path;
      $('conflict-tip').textContent =
        op.type === 'stash'
          ? '编辑工作区 → 保存 → git add；全部解决后即可正常提交，stash 记录仍保留'
          : '编辑工作区 → 保存 → git add → git ' + op.type + ' --continue';
      $('ours-label').textContent = op.type === 'rebase' ? '当前版本 · 新基点上的历史' : '当前版本 · HEAD';
      $('theirs-label').textContent =
        ['rebase', 'cherry-pick'].includes(op.type)
          ? '传入版本 · 待重放的提交'
          : '传入版本 · ' + (op.type === 'revert' ? '反向改动' : op.type === 'stash' ? 'stash 中的改动' : '另一分支');
      $('conflict-base').textContent = conflict.base ?? '（此版本没有该文件）';
      $('conflict-ours').textContent = conflict.ours ?? '（此版本删除了文件）';
      $('conflict-theirs').textContent = conflict.theirs ?? '（此版本删除了文件）';
    }
  }

  /** 选择节点只更新详情，展开与折叠由用户点击标题控制，刷新内容时保留手动选择。 */
  function showCommit(commit, remoteOnly) {
    selectedCommit = commit.id;
    $('commit-summary').textContent = commit.id + ' · ' + commit.message + (remoteOnly ? '（仅远程）' : '');
    GitGraphViewer.renderCommit($('commit-content'), commit, graphState());
  }

  function saveEditor(quiet = false) {
    if (editorMode !== 'local') return saveRemoteEditor(quiet);
    try {
      if (!selectedFile) return false;
      sim.editFile(selectedFile, $('file-editor').value);
      dirty = false;
      renderFiles();
      if (!quiet) message('已保存到工作区。输入 git add 将改动放入暂存区。');
      return true;
    } catch (error) {
      message(error.message, true);
      return false;
    }
  }

  function updateExplanation(result, command) {
    $('explanation-title').textContent = result.ok ? (result.conflict ? '遇到冲突，先停下来看看' : command) : '这条命令需要调整';
    $('explanation').textContent = result.ok ? result.explanation : result.output + ' ' + result.explanation;
    $('flow').replaceChildren();
    const owner = result.actor && result.actor !== 'local' ? roles[result.actor].owner : '';
    if (result.ok && ['add', 'commit', 'reset'].includes(result.command?.name)) {
      [owner + '工作区', '→', owner + '暂存区', '→', owner + '提交 / HEAD'].forEach(
        (text, i) => {
          const active =
            (result.command.name === 'add' && i === 2) ||
            (result.command.name === 'commit' && i === 4) ||
            result.command.name === 'reset';
          $('flow').append(node('span', active ? 'flow-active' : '', text));
        }
      );
    }
    if (result.ok && owner && result.command?.name === 'push') {
      [owner + '本地提交', '→', '共享远程分支 ' + result.branch, '· 其他身份需 fetch 更新跟踪引用'].forEach((text, i) =>
        $('flow').append(node('span', i === 2 ? 'flow-active' : '', text))
      );
    }
    if (result.ok && result.command?.name === 'restore') {
      const labels = result.command.staged
        ? ['HEAD', '→', '暂存区', '· 工作区保留']
        : ['暂存区', '→', '工作区', '· 丢弃未暂存修改'];
      labels.forEach((text, i) => $('flow').append(node('span', i === 2 ? 'flow-active' : '', text)));
    }
    if (result.ok && result.command?.name === 'stash' && ['push', 'pop', 'apply'].includes(result.command.action)) {
      const labels =
        result.command.action === 'push'
          ? ['工作区 / 暂存区', '→', 'stash@{0}']
          : ['stash@{' + (result.command.index || 0) + '}', '→', '工作区 / 暂存区'];
      labels.forEach((text, i) => $('flow').append(node('span', i === 2 ? 'flow-active' : '', text)));
    }
    animateFiles(result);
  }

  /** 重播暂存或提交时也重播区域流转提示，无需再次执行命令。 */
  function animateFiles(result) {
    $('flow').classList.remove('flash');
    void $('flow').offsetWidth;
    $('flow').classList.add('flash');
    filePanel.classList.remove('file-flowing', 'commit-flowing');
    if (result.ok && (result.actor || 'local') === editorMode && ['add', 'commit'].includes(result.command?.name)) {
      void $('files-title').offsetWidth;
      filePanel.classList.add(result.command.name === 'add' ? 'file-flowing' : 'commit-flowing');
    }
  }

  function runCommand(event) {
    event.preventDefault();
    cancelReplay();
    const input = $('command').value.trim();
    if (!input) return;
    const remote = editorMode !== 'local';
    const session = remote ? remoteSession() : null;
    if ((remote ? session?.dirty : dirty) && !saveEditor(true)) return;
    const branch = remote ? session?.workspace.branch : sim.state.head.branch;
    history.push(input);
    historyIndex = history.length;
    draft = '';
    const result = remote
      ? session
        ? session.workspace.execute(sim, input)
        : { ok: false, output: '暂无远程分支，请切回本地 push 后再试。', explanation: '命令未执行。' }
      : sim.execute(input);
    const changed = Boolean(result.ok || result.fetchCompleted);
    lesson.record(result);
    if (remote && result.ok && result.command.name === 'commit') {
      session.message = '';
      showCommit(session.workspace.commits[result.commitId], false);
    }
    terminalEntry(input, result.output, result, editorMode, branch);
    if (remote && result.ok && result.conflict) session.selectedFile = session.workspace.pending.unresolved[0];
    $('command').value = '';
    message();
    if (!remote) dirty = false;
    render(changed);
    updateExplanation(result, input);
    if (changed) replayController.setResult(result);
    if (!remote && result.ok && result.conflict) {
      selectedFile = sim.state.pending.unresolved[0];
      renderFiles();
    }
  }

  Object.entries(SCENES).forEach(([key, info], i) => {
    const button = node('button', 'scene-button');
    button.type = 'button';
    button.dataset.scene = key;
    const copy = node('span', 'scene-copy');
    copy.append(node('strong', '', info.title), node('small', '', labels[i] || info.subtitle));
    button.append(node('span', 'scene-index', String(i + 1).padStart(2, '0')), copy);
    button.addEventListener('click', () => {
      if (key === sim.scene) restartScene();
      else loadScene(key);
    });
    $('scenes').append(button);
  });

  GitHelpManual.mount({
    dialog: $('help-dialog'),
    content: $('help-content'),
    onSelectCommand: (command, selection) => {
      fillCommand(command);
      const start = selection ? command.indexOf(selection) : -1;
      if (start >= 0) $('command').setSelectionRange(start, start + selection.length);
    }
  });

  // 工作区保留可编辑文本，同时提供按行着色的差异视图。
  const workDetails = node('details', 'work-diff');
  workDetails.append(node('summary', '', '查看工作区相对暂存区的差异'));
  const workDiff = node('pre', 'code-view');
  workDiff.id = 'work-diff';
  workDetails.append(workDiff);
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
    renderFileMarkerNotice($('file-editor').value);
    if (editorMode !== 'local') {
      const session = remoteSession();
      if (session) {
        session.buffer = $('file-editor').value;
        session.dirty = true;
        $('editor-status').textContent = roles[editorMode].owner + '草稿 · 执行命令时自动保存';
        renderRecommendations();
      }
      return;
    }
    dirty = true;
    $('editor-status').textContent = '编辑草稿 · 执行命令时自动保存';
    renderRecommendations();
    renderLesson();
  });

  $('save-file').addEventListener('click', () => saveEditor());
  $('file-select').addEventListener('change', () => {
    const target = $('file-select').value;
    if (editorMode !== 'local') {
      const session = remoteSession();
      if (session.dirty && !saveRemoteEditor(true)) {
        $('file-select').value = session.selectedFile;
        return;
      }
      session.selectedFile = target;
      session.dirty = false;
      renderFiles();
      message();
      return;
    }
    if (dirty && !saveEditor(true)) {
      $('file-select').value = selectedFile;
      return;
    }
    selectedFile = target;
    dirty = false;
    message();
    renderFiles();
  });

  $('delete-file').addEventListener('click', () => {
    try {
      if (editorMode !== 'local') {
        const session = remoteSession();
        session.workspace.deleteFile(session.selectedFile);
        session.dirty = false;
        renderFiles();
        message('已从' + roles[editorMode].owner + '工作区删除，请暂存这次删除。');
        return;
      }
      sim.deleteFile(selectedFile);
      dirty = false;
      renderFiles();
      message('已从虚拟工作区删除。输入 git add 暂存这次删除。');
    } catch (error) {
      message(error.message, true);
    }
  });

  $('new-file').addEventListener('click', () => {
    $('new-file-form').hidden = false;
    $('new-path').focus();
  });
  $('cancel-new').addEventListener('click', () => {
    $('new-file-form').hidden = true;
  });
  $('new-file-form').addEventListener('submit', event => {
    event.preventDefault();
    if (editorMode !== 'local') {
      const session = remoteSession();
      if (!session || (session.dirty && !saveRemoteEditor(true))) return;
      const path = $('new-path').value.trim();
      try {
        if (session.workspace.fileStatus().some(file => file.path === path)) {
          throw new Error('该文件已经存在，请从文件列表中选择。');
        }
        session.workspace.editFile(path, '');
        session.selectedFile = path;
        session.dirty = false;
        $('new-file-form').hidden = true;
        $('new-path').value = '';
        renderFiles();
        message('已在' + roles[editorMode].owner + '工作区创建文件。');
        $('file-editor').focus();
      } catch (error) {
        message(error.message, true);
      }
      return;
    }
    if (dirty && !saveEditor(true)) return;
    const path = $('new-path').value.trim();
    try {
      if (Object.hasOwn(sim.state.work, path)) throw new Error('工作区已有同名文件，请从文件列表中选择。');
      sim.editFile(path, '');
      selectedFile = path;
      dirty = false;
      $('new-file-form').hidden = true;
      $('new-path').value = '';
      renderFiles();
      $('file-editor').focus();
      message('已创建虚拟文件，请输入内容并保存。');
    } catch (error) {
      message(error.message, true);
    }
  });

  for (const [id, side] of [['use-ours', 'ours'], ['use-theirs', 'theirs']]) {
    $(id).addEventListener('click', () => {
      const session = remoteSession();
      const workspace = session?.workspace;
      const path = workspace ? session.selectedFile : selectedFile;
      const repository = workspace || sim;
      const conflict = (workspace ? workspace.pending : sim.state.pending)?.conflicts[path];
      if (!conflict) return;
      if (conflict[side] === null) {
        if (Object.hasOwn(workspace ? workspace.work : sim.state.work, path)) repository.deleteFile(path);
      } else {
        repository.editFile(path, conflict[side]);
      }
      if (session) session.dirty = false;
      else dirty = false;
      renderFiles();
      message('已选择此版本，请检查内容，再 git add 并继续。');
    });
  }

  $('replay').addEventListener('click', () => replayController.replay());
  $('restart').addEventListener('click', restartScene);
  $('undo-restart').addEventListener('click', undoRestart);
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  $('close-help').addEventListener('click', () => $('help-dialog').close());
  $('help-dialog').addEventListener('click', event => {
    if (event.target !== $('help-dialog')) return;
    const rect = $('help-dialog').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      $('help-dialog').close();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== '?' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (document.activeElement?.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    $('help-dialog').showModal();
  });

  $('zoom-in').addEventListener('click', () => {
    graph.setZoom(graph.zoom + 0.2);
    syncZoomButtons();
  });
  $('zoom-out').addEventListener('click', () => {
    graph.setZoom(graph.zoom - 0.2);
    syncZoomButtons();
  });
  $('zoom-reset').addEventListener('click', () => {
    graph.fit();
    syncZoomButtons();
  });
  $('zoom-default').addEventListener('click', () => {
    graph.setZoom(CommitGraph.DEFAULT_ZOOM);
    syncZoomButtons();
  });
  graphViewer.dialog.addEventListener('close', syncZoomButtons);
  // 页面进入往返缓存时也释放旧命令和撤销快照，避免恢复页面时找回上一轮数据。
  window.addEventListener('pagehide', () => {
    setResetUndo(null);
    clearCommandHistory();
  });

  loadScene('basic');
})();
