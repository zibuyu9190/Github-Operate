/* 放大查看复用原 SVG：只移动画布，不复制提交图，也不读写虚拟仓库。 */
(function (root) {
  'use strict';

  /** 复用模拟器的行编辑结果；独立累计新旧行号，前后各保留三行上下文并合并相邻片段。 */
  function unifiedHunks(before, after) {
    const original = (before || '').match(/[^\n]*\n|[^\n]+$/g) || [], rows = [];
    let oldLine = 1, newLine = 1;
    const append = (kind, text) => {
      rows.push({ kind, text: text.replace(/\r?\n$/, ''), oldLine: kind === 'added' ? null : oldLine,
        newLine: kind === 'removed' ? null : newLine, oldCursor: oldLine, newCursor: newLine, noNewline: !text.endsWith('\n') });
      if (kind !== 'added') oldLine++;
      if (kind !== 'removed') newLine++;
    };
    for (const change of root.GitSimulator.edits(before, after)) {
      while (oldLine <= change.start) append('context', original[oldLine - 1]);
      for (const text of original.slice(change.start, change.end)) append('removed', text);
      for (const text of change.lines) append('added', text);
    }
    while (oldLine <= original.length) append('context', original[oldLine - 1]);
    const ranges = [];
    rows.forEach((row, index) => {
      if (row.kind === 'context') return;
      const start = Math.max(0, index - 3), end = Math.min(rows.length, index + 4), last = ranges.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else ranges.push({ start, end });
    });
    return ranges.map(({ start, end }) => {
      const content = rows.slice(start, end), oldRows = content.filter(row => row.oldLine !== null), newRows = content.filter(row => row.newLine !== null);
      // 空侧从插入/删除位置计数；新增文件必须显示 -0,0，删除文件则显示 +0,0。
      const range = (number, count) => count === 1 ? String(number) : number + ',' + count;
      const oldStart = oldRows.length ? oldRows[0].oldLine : content[0].oldCursor - 1;
      const newStart = newRows.length ? newRows[0].newLine : content[0].newCursor - 1;
      return { header: '@@ -' + range(oldStart, oldRows.length) + ' +' + range(newStart, newRows.length) + ' @@', rows: content };
    });
  }

  class GraphViewer {
    /** 主页面与放大图共用差异视图；合并提交以第一父提交为基准，新增/删除同时用文字和颜色标明。 */
    static renderCommit(container, commit, state) {
      const make = (tag, className, text) => {
        const item = document.createElement(tag); item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
      };
      const parentId = commit.parents[0], parent = state.commits[parentId] || state.remote.commits[parentId];
      container.replaceChildren(make('p', '', '模拟短 ID：' + commit.hash + ' · 父提交：' + (commit.parents.join('、') || '无（初始提交）')));
      if (parentId && !parent) {
        container.append(make('p', '', '父提交快照不可用，请查看完整文件快照。'));
      } else {
        const baseline = parent?.tree || {};
        // 文件名可能与对象原型属性同名，只读取快照中实际存在的文件。
        const textAt = (tree, path) => Object.prototype.hasOwnProperty.call(tree, path) ? tree[path] : undefined;
        const changed = [...new Set([...Object.keys(baseline), ...Object.keys(commit.tree)])].sort().filter(path => textAt(baseline, path) !== textAt(commit.tree, path));
        container.append(make('p', 'commit-diff-legend', '本次改动 · ' + (parentId ? '相对第一父提交 ' + parentId : '相对空仓库') + ' · 旧 / 新行号 · + 新增 / − 删除 · 白色为未修改上下文'));
        if (!changed.length) container.append(make('p', '', '本次提交没有文件内容变化。'));
        for (const path of changed) {
          const before = textAt(baseline, path), after = textAt(commit.tree, path);
          const section = make('div', 'commit-change');
          section.append(make('strong', 'commit-change-title', (before === undefined ? '新增' : after === undefined ? '删除' : '修改') + ' · ' + path));
          const preview = make('div', 'commit-diff'); preview.tabIndex = 0; preview.setAttribute('aria-label', path + ' 的提交差异');
          const table = make('table', 'commit-diff-table'), head = make('thead', ''), heading = make('tr', ''), body = make('tbody', '');
          ['旧行号', '新行号', '变化', '内容'].forEach((label, index) => {
            const cell = make('th', index < 2 ? 'commit-diff-number' : index === 2 ? 'commit-diff-sign' : 'commit-diff-code', label);
            cell.setAttribute('scope', 'col'); heading.append(cell);
          });
          head.append(heading); table.append(head, body); preview.append(table);
          const hunks = unifiedHunks(before, after);
          for (const hunk of hunks) {
            const header = make('tr', 'commit-diff-hunk'), label = make('td', '', hunk.header); label.colSpan = 4; header.append(label); body.append(header);
            for (const line of hunk.rows) {
              const row = make('tr', 'commit-diff-row commit-diff-' + line.kind);
              row.append(make('td', 'commit-diff-number', line.oldLine === null ? '' : String(line.oldLine)),
                make('td', 'commit-diff-number', line.newLine === null ? '' : String(line.newLine)),
                make('td', 'commit-diff-sign', line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''),
                make('td', 'commit-diff-code', line.text));
              body.append(row);
              if (line.noNewline) {
                const note = make('tr', 'commit-diff-note'), cell = make('td', '', '\\ 文件末尾没有换行'); cell.colSpan = 4; note.append(cell); body.append(note);
              }
            }
          }
          if (!hunks.length) preview.append(make('p', 'commit-diff-empty', after === undefined ? '删除空文件' : '新增空文件'));
          section.append(preview); container.append(section);
        }
      }
      // 完整快照折叠保留，优先让用户看见本次变化；文件与说明始终只进入文本节点。
      const snapshot = make('details', 'commit-full-snapshot');
      snapshot.append(make('summary', '', '完整文件快照（' + Object.keys(commit.tree).length + ' 个文件）'));
      for (const [path, text] of Object.entries(commit.tree)) snapshot.append(make('strong', '', path), make('pre', '', text || '（空文件）'));
      if (!Object.keys(commit.tree).length) snapshot.append(make('p', '', '空文件树'));
      container.append(snapshot); container.scrollTop = 0;
    }

    constructor(graph, stage, readContext, beforeOpen) {
      this.graph = graph; this.stage = stage; this.readContext = readContext; this.beforeOpen = beforeOpen;
      const make = (tag, className, text) => {
        const item = document.createElement(tag); item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
      };
      this.make = make;
      const button = (text, label, action) => {
        const item = make('button', 'graph-viewer-button', text); item.type = 'button';
        item.setAttribute('aria-label', label); item.title = label; item.addEventListener('click', action); return item;
      };
      this.trigger = button('⛶ 放大查看', '放大查看提交图', () => this.open());
      this.trigger.id = 'graph-expand'; this.trigger.setAttribute('aria-haspopup', 'dialog');
      this.trigger.setAttribute('aria-controls', 'graph-viewer');
      document.querySelector('.graph-tools').append(this.trigger);

      this.dialog = make('dialog', 'graph-viewer'); this.dialog.id = 'graph-viewer';
      this.dialog.setAttribute('aria-labelledby', 'graph-viewer-title');
      this.dialog.setAttribute('aria-describedby', 'graph-viewer-hint');
      const header = make('header', 'graph-viewer-header'), heading = make('div', 'graph-viewer-heading');
      this.title = make('h2', '', '提交图 · 放大查看'); this.title.id = 'graph-viewer-title';
      const hint = make('p', '', '点击提交节点查看快照 · 使用按钮缩放 · Esc 关闭'); hint.id = 'graph-viewer-hint';
      heading.append(this.title, hint);
      const tools = make('div', 'graph-viewer-tools');
      this.zoomLabel = make('output', 'graph-viewer-scale', '100%'); this.zoomLabel.setAttribute('aria-label', '大图缩放比例');
      this.zoomOut = button('−', '缩小大图', () => this.zoom(this.graph.zoom - .2));
      this.zoomIn = button('＋', '放大大图', () => this.zoom(this.graph.zoom + .2));
      this.closeButton = button('✕ 关闭', '关闭放大图', () => this.dialog.close()); this.closeButton.autofocus = true;
      tools.append(this.zoomOut, this.zoomLabel, this.zoomIn, button('适应画布', '适应大图画布', () => this.zoom()), this.closeButton);
      header.append(heading, tools);
      this.canvas = make('div', 'graph-viewer-canvas');
      this.details = make('details', 'graph-viewer-details');
      this.summary = make('summary', '', '点击提交节点，查看说明与文件快照');
      this.content = make('div', 'graph-viewer-snapshot'); this.details.append(this.summary, this.content);
      this.dialog.append(header, this.canvas, this.details); document.body.append(this.dialog);

      // 保留原来的节点选择行为；大图中再就地显示快照，避免跳到弹窗后方。
      const select = graph.onSelect;
      graph.onSelect = (commit, remoteOnly) => {
        select(commit, remoteOnly); this.selected = { commit, remoteOnly };
        if (this.dialog.open) this.showCommit(commit, remoteOnly);
      };
      stage.classList.add('graph-expandable'); stage.tabIndex = 0;
      stage.setAttribute('aria-label', '提交图，按 Enter 放大查看'); stage.setAttribute('aria-haspopup', 'dialog');
      stage.setAttribute('aria-controls', this.dialog.id);
      stage.addEventListener('click', event => {
        if (this.dialog.open || window.getSelection()?.toString()) return;
        // 点击滚动条只滚动画布，不触发放大。
        const rect = stage.getBoundingClientRect();
        if (event.clientX >= rect.left + stage.clientWidth || event.clientY >= rect.top + stage.clientHeight) return;
        this.open(Boolean(event.target.closest('.commit-node')));
      });
      stage.addEventListener('keydown', event => {
        if (event.target !== stage || !['Enter', ' '].includes(event.key) || this.dialog.open) return;
        event.preventDefault(); this.open();
      });
      const caption = stage.querySelector('.canvas-caption');
      if (caption) caption.textContent = '点击提交图放大查看 · 点击节点查看快照';
      this.dialog.addEventListener('click', event => {
        if (event.target !== this.dialog) return;
        const rect = this.dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.dialog.close();
      });
      this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.restore(); });
      this.details.addEventListener('toggle', () => { if (this.dialog.open) this.graph.resize(); });
    }

    /** 用占位符保存原位置；打开和关闭均保留主画布缩放、滚动位置及未保存的编辑草稿。 */
    open(showSelection = false) {
      if (this.dialog.open) return;
      // 原生 close 事件可能下一帧才到达；快速重开时先归位，避免占位符留在弹窗内部。
      if (this.placeholder) this.restore();
      this.beforeOpen();
      this.previous = { zoom: this.graph.zoom, fitted: this.graph.fitted, left: this.stage.scrollLeft, top: this.stage.scrollTop, focus: document.activeElement };
      this.placeholder = document.createComment('提交图原位置'); this.stage.before(this.placeholder);
      this.canvas.append(this.stage);
      const context = this.readContext(); this.title.textContent = context.title + ' · 提交图';
      this.details.open = false; this.content.replaceChildren(); this.summary.textContent = '点击提交节点，查看说明与文件快照';
      document.body.classList.add('graph-viewer-open'); this.dialog.showModal();
      this.graph.draw(context.state); this.zoom(1); this.stage.scrollLeft = 0; this.stage.scrollTop = 0;
      if (showSelection && this.selected) this.showCommit(this.selected.commit, this.selected.remoteOnly);
    }

    zoom(value) {
      if (value === undefined) this.graph.fit();
      else this.graph.setZoom(value);
      this.zoomLabel.textContent = this.graph.fitted ? '适应' : Math.round(this.graph.zoom * 100) + '%';
      this.zoomOut.disabled = this.graph.zoom <= .6; this.zoomIn.disabled = this.graph.zoom >= 2.5;
    }

    /** 选择只更新纯文本详情，默认折叠；保留用户通过标题手动展开或收起的状态。 */
    showCommit(commit, remoteOnly) {
      this.summary.textContent = commit.id + ' · ' + commit.message + (remoteOnly ? '（仅远程）' : '');
      GraphViewer.renderCommit(this.content, commit, this.readContext().state);
      this.details.scrollTop = 0;
      this.graph.resize();
    }

    restore() {
      if (!this.placeholder) return;
      this.placeholder.replaceWith(this.stage); this.placeholder = null;
      document.body.classList.remove('graph-viewer-open');
      if (this.previous.fitted) this.graph.fit();
      else this.graph.setZoom(this.previous.zoom);
      this.stage.scrollLeft = this.previous.left; this.stage.scrollTop = this.previous.top;
      const focus = this.previous.focus?.isConnected ? this.previous.focus : this.trigger;
      focus.focus({ preventScroll: true });
    }
  }

  root.GitGraphViewer = GraphViewer;
})(globalThis);

/* 浏览已提交快照，不执行命令、不保存编辑草稿，也不提前同步远程引用。 */
(function (root) {
  'use strict';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const SOURCES = { remote: '远程仓库 · origin', local: '本地仓库', tracking: '本地远程跟踪 · origin/*' };

  function fileStats(text) {
    const rows = text ? text.split('\n') : [];
    if (rows.at(-1) === '') rows.pop();
    return { lines: rows.length, bytes: new TextEncoder().encode(text).length, rows };
  }

  /** 用路径分段区分目录边界，Map 避免普通文件名与对象原型属性冲突。 */
  function listEntries(tree, directory = '') {
    const prefix = directory ? directory + '/' : '', entries = new Map();
    for (const path of Object.keys(tree)) {
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length), split = relative.indexOf('/');
      if (!relative) continue;
      const name = split < 0 ? relative : relative.slice(0, split), target = prefix + name;
      if (!entries.has(name)) entries.set(name, { name, path: target, directory: split >= 0, ...(split < 0 ? fileStats(tree[path]) : {}) });
    }
    return [...entries.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN'));
  }

  /** 按路径简化历史：合并结果沿内容相同的父提交追溯，避免把导入的文件都误记为合并提交。 */
  function latestPathCommit(commits, tip, path, directory = false) {
    if (!own(commits, tip) || !(directory ? Object.keys(commits[tip].tree).some(file => file.startsWith(path + '/')) : own(commits[tip].tree, path))) return null;
    const samePath = (a, b) => {
      if (!directory) return own(a, path) === own(b, path) && a[path] === b[path];
      const prefix = path + '/', paths = new Set([...Object.keys(a), ...Object.keys(b)].filter(file => file.startsWith(prefix)));
      return [...paths].every(file => own(a, file) === own(b, file) && a[file] === b[file]);
    };
    const seen = new Set();
    while (own(commits, tip) && !seen.has(tip)) {
      seen.add(tip);
      const commit = commits[tip];
      if (!commit.parents.length) return commit;
      // 缺少历史对象时明确留空，不能借用另一来源的对象补出未经同步的提交信息。
      if (commit.parents.some(id => !own(commits, id))) return null;
      const unchanged = commit.parents.find(id => samePath(commit.tree, commits[id].tree));
      if (unchanged === undefined) return commit;
      tip = unchanged;
    }
    return null;
  }

  /** 时间来自模拟提交创建时刻；旧对象无时间字段时明确说明，不编造月份或推送时间。 */
  function commitAge(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp) || timestamp <= 0 || Number.isNaN(new Date(timestamp).getTime())) return '时间未记录';
    const elapsed = now - timestamp;
    if (elapsed < 0) return new Date(timestamp).toLocaleDateString('zh-CN');
    if (elapsed < 60000) return '刚刚';
    if (elapsed < 3600000) return Math.floor(elapsed / 60000) + ' 分钟前';
    if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + ' 小时前';
    return Math.floor(elapsed / 86400000) + ' 天前';
  }

  /** 来源决定对象可见范围；本地跟踪引用只读取本地对象，不借用远程尚未下载的文件。 */
  function references(state, source) {
    if (!own(SOURCES, source)) throw new Error('未知的仓库查看位置。');
    const branches = source === 'remote' ? state.remote.branches : source === 'local' ? state.branches : state.tracking;
    const refs = Object.entries(branches).sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([name, id]) => ({ key: 'branch:' + name, name, id }));
    if (source === 'local' && !state.head.branch) refs.unshift({ key: 'head:', name: 'HEAD（分离状态）', id: state.head.id });
    return refs;
  }

  class Model {
    constructor(source = 'remote') { this.source = source; this.reference = ''; this.directory = ''; this.file = null; }

    /** 分支前进后重新读取快照；文件被删除时退回最近仍存在的目录，不展示旧文件内容。 */
    read(state) {
      const refs = references(state, this.source);
      let ref = refs.find(ref => ref.key === this.reference);
      if (!ref) {
        ref = refs.find(ref => this.source === 'local' && (state.head.branch ? ref.name === state.head.branch : ref.key === 'head:')) || refs.find(ref => ref.name === 'main') || refs[0];
        this.reference = ref?.key || '';
      }
      const commits = this.source === 'remote' ? state.remote.commits : state.commits;
      const commit = ref && own(commits, ref.id) ? commits[ref.id] : null, tree = commit?.tree || {};
      let notice = '';
      if (this.file && !own(tree, this.file)) { this.file = null; notice = '该文件在当前版本中不存在，已返回目录。'; }
      while (this.directory && !Object.keys(tree).some(path => path.startsWith(this.directory + '/'))) this.directory = this.directory.split('/').slice(0, -1).join('/');
      const entries = listEntries(tree, this.directory).map(entry => ({ ...entry, lastCommit: latestPathCommit(commits, ref.id, entry.path, entry.directory) }));
      const fileCommit = this.file ? latestPathCommit(commits, ref.id, this.file) : null;
      return { source: this.source, refs, ref, commit, commits, tree, directory: this.directory, file: this.file, entries, fileCommit, total: Object.keys(tree).length, notice };
    }

    selectSource(source, state) {
      const available = references(state, source), name = references(state, this.source).find(ref => ref.key === this.reference)?.name;
      this.source = source; this.reference = available.find(ref => ref.name === name)?.key || '';
      return this.read(state);
    }

    selectReference(key, state) {
      if (!references(state, this.source).some(ref => ref.key === key)) throw new Error('该分支在当前查看位置不存在。');
      this.reference = key; return this.read(state);
    }

    openPath(path, state) {
      const snapshot = this.read(state);
      if (own(snapshot.tree, path)) { this.file = path; this.directory = path.split('/').slice(0, -1).join('/'); }
      else if (path === '' || Object.keys(snapshot.tree).some(file => file.startsWith(path + '/'))) { this.file = null; this.directory = path; }
      else return false;
      return true;
    }
  }

  class View {
    /** 原生 dialog 负责焦点范围与 Esc；关闭后还原入口焦点，不重建现有文件编辑器。 */
    constructor(readContext, beforeOpen) {
      this.readContext = readContext; this.beforeOpen = beforeOpen;
      this.actor = 'local'; this.model = new Model('local'); this.models = new Map([[this.actor, this.model]]);
      const make = (tag, className, text) => {
        const item = document.createElement(tag); if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
      };
      this.make = make;
      this.button = (text, action, className = 'repo-button') => { const item = make('button', className, text); item.type = 'button'; item.addEventListener('click', action); return item; };
      this.trigger = this.button('仓库浏览', () => this.open(), 'button quiet repository-trigger'); this.trigger.id = 'repository-open';
      this.trigger.setAttribute('aria-haspopup', 'dialog'); this.trigger.setAttribute('aria-controls', 'repository-browser');
      document.getElementById('help-button').before(this.trigger);
      this.dialog = make('dialog', 'repository-browser'); this.dialog.id = 'repository-browser';
      this.dialog.setAttribute('aria-labelledby', 'repository-title'); this.dialog.setAttribute('aria-describedby', 'repository-hint');
      const header = make('header', 'repo-header'), identity = make('div', 'repo-identity');
      this.actorBadge = make('span', 'repo-badge');
      identity.append(make('span', 'repo-symbol', '▣'), make('h2', '', 'Git Playground'), this.actorBadge);
      identity.querySelector('h2').id = 'repository-title';
      this.closeButton = this.button('关闭', () => this.dialog.close()); this.closeButton.setAttribute('aria-label', '关闭仓库浏览');
      header.append(identity, this.closeButton);
      const tab = make('div', 'repo-code-tab'); tab.append(make('strong', '', '〈〉代码'), make('span', '', '浏览已提交文件'));
      const controls = make('div', 'repo-controls');
      this.sourceSelect = make('select'); this.sourceSelect.id = 'repository-source';
      for (const [key, value] of Object.entries(SOURCES)) { const option = make('option', '', value); option.value = key; this.sourceSelect.append(option); }
      this.branchSelect = make('select'); this.branchSelect.id = 'repository-branch';
      for (const [label, select] of [['查看位置', this.sourceSelect], ['分支', this.branchSelect]]) {
        const group = make('div', 'repo-control'), caption = make('label', '', label); caption.htmlFor = select.id; group.append(caption, select); controls.append(group);
      }
      this.count = make('span', 'repo-file-count'); controls.append(this.count);
      this.sourceSelect.addEventListener('change', () => { const { state } = this.context(); this.render(this.model.selectSource(this.sourceSelect.value, state)); });
      this.branchSelect.addEventListener('change', () => { const { state } = this.context(); this.render(this.model.selectReference(this.branchSelect.value, state)); });
      this.hint = make('p', 'repo-hint'); this.hint.id = 'repository-hint';
      this.notice = make('p', 'repo-notice'); this.notice.setAttribute('role', 'status');
      this.commit = make('div', 'repo-latest');
      this.breadcrumb = make('nav', 'repo-breadcrumb'); this.breadcrumb.setAttribute('aria-label', '仓库文件路径');
      this.commitDetails = make('section', 'repo-commit-details'); this.commitDetails.hidden = true; this.commitDetails.tabIndex = -1;
      this.commitDetails.setAttribute('aria-label', '提交详情');
      this.commitDetailTitle = make('h3');
      this.commitDetailBody = make('div', 'repo-commit-body');
      const detailHeader = make('div', 'repo-commit-header');
      detailHeader.append(this.commitDetailTitle, this.button('收起提交详情', () => {
        this.commitDetails.hidden = true;
        (this.commitReturnFocus?.isConnected ? this.commitReturnFocus : this.branchSelect).focus();
      }));
      this.commitDetails.append(detailHeader, this.commitDetailBody);
      this.content = make('div', 'repo-content'); this.content.tabIndex = -1;
      const body = make('div', 'repo-body'); body.append(this.commit, this.breadcrumb, this.commitDetails, this.content);
      this.dialog.append(header, tab, controls, this.hint, this.notice, body); document.body.append(this.dialog);
      this.dialog.addEventListener('close', () => {
        // 原生 close 事件可能延迟到再次打开后才派发，此时保留新弹窗的滚动锁与焦点。
        if (this.dialog.open) return;
        document.body.classList.remove('repository-browser-open');
        if (this.previousFocus?.isConnected) this.previousFocus.focus();
      });
      this.dialog.addEventListener('click', event => {
        if (event.target !== this.dialog) return;
        const rect = this.dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.dialog.close();
      });
    }

    /** 浏览状态按身份隔离；切换只读取该方快照，不执行同步或修改任何仓库。 */
    context() {
      const context = this.readContext(), actor = context.actor === 'remote' ? 'remote' : 'local';
      if (actor !== this.actor) {
        this.actor = actor;
        if (!this.models.has(actor)) this.models.set(actor, new Model('local'));
        this.model = this.models.get(actor);
      }
      return { ...context, actor };
    }

    reset() {
      this.actor = 'local'; this.model = new Model('local'); this.models = new Map([[this.actor, this.model]]);
      if (this.dialog.open) this.render();
    }

    open() {
      if (this.dialog.open) return;
      this.beforeOpen(); this.previousFocus = document.activeElement; this.render();
      document.body.classList.add('repository-browser-open'); this.dialog.showModal(); this.branchSelect.focus();
    }

    navigate(path) {
      const { state } = this.context();
      if (!this.model.openPath(path, state)) return;
      this.render(); this.content.focus(); this.content.parentElement.scrollTop = 0;
    }

    render(snapshot) {
      const { state, actor } = this.context(), make = this.make;
      snapshot = snapshot || this.model.read(state);
      const owner = actor === 'remote' ? '协作者' : '我的';
      this.actorBadge.textContent = actor === 'remote' ? '虚拟仓库 · 协作者视角' : '虚拟仓库 · 我的本地视角';
      const sources = { remote: '共享远程仓库 · origin', local: owner + '本地仓库', tracking: owner + '远程跟踪 · origin/*' };
      for (const option of this.sourceSelect.children) option.textContent = sources[option.value];
      this.sourceSelect.value = snapshot.source;
      this.branchSelect.replaceChildren(...snapshot.refs.map(ref => { const option = make('option', '', ref.name); option.value = ref.key; return option; }));
      this.branchSelect.value = snapshot.ref?.key || ''; this.branchSelect.disabled = !snapshot.refs.length;
      this.count.textContent = snapshot.total + ' 个已提交文件';
      const meanings = { remote: '这里是双方共享远程已接收的文件；任一方 push 后即可查看，只有本地 commit 尚不可见。', local: '这里是' + owner + '本地分支已提交的文件；工作区和暂存区中的未提交改动不在此显示。', tracking: '这里是' + owner + '本地记录的远程版本；该身份 fetch 更新跟踪引用，pull 才进一步整合本地分支。' };
      this.hint.textContent = meanings[snapshot.source] + ' 此视图只读，切换查看不会切换 HEAD 或改动草稿。';
      this.notice.textContent = snapshot.notice; this.notice.hidden = !snapshot.notice;
      this.commit.replaceChildren(); this.breadcrumb.replaceChildren(); this.content.replaceChildren();
      this.commitDetails.hidden = true; this.commitDetailBody.replaceChildren();
      if (!snapshot.commit) {
        this.content.append(make('p', 'repo-empty', snapshot.ref ? '当前提交对象不可用，请先同步对应的本地记录。' : '此位置暂无分支。可在本地创建分支并 push 后查看远程仓库。')); return;
      }
      this.commit.append(make('span', 'repo-commit-icon', '●'), this.commitButton(snapshot.commit, snapshot), this.commitTime(snapshot.commit));
      this.breadcrumb.append(this.button('Git Playground', () => this.navigate(''), 'repo-path-button'));
      const parts = (snapshot.file || snapshot.directory).split('/').filter(Boolean);
      parts.forEach((part, i) => {
        this.breadcrumb.append(make('span', 'repo-path-separator', '/'));
        if (snapshot.file && i === parts.length - 1) { const current = make('span', 'repo-current-path', part); current.setAttribute('aria-current', 'page'); this.breadcrumb.append(current); }
        else this.breadcrumb.append(this.button(part, () => this.navigate(parts.slice(0, i + 1).join('/')), 'repo-path-button'));
      });
      if (snapshot.file) this.renderFile(snapshot);
      else this.renderDirectory(snapshot);
    }

    commitTime(commit) {
      const timestamp = commit?.timestamp, age = commitAge(timestamp), time = this.make('time', 'repo-entry-time', age);
      if (age !== '时间未记录') { time.dateTime = new Date(timestamp).toISOString(); time.title = new Date(timestamp).toLocaleString('zh-CN'); }
      return time;
    }

    commitButton(commit, snapshot) {
      const button = this.button('', () => this.showCommit(commit, snapshot, button), 'repo-commit-link');
      button.setAttribute('aria-label', '查看提交 ' + commit.id + '：' + commit.message);
      button.title = commit.message + ' · ' + commit.id;
      button.append(this.make('span', 'repo-commit-message', commit.message.split(/\r?\n/)[0]), this.make('code', 'repo-commit-id', commit.id));
      return button;
    }

    /** 详情只读取当前查看来源的提交对象，打开和收起都不移动 HEAD 或覆盖编辑草稿。 */
    showCommit(commit, snapshot, trigger) {
      this.commitReturnFocus = trigger;
      this.commitDetailTitle.textContent = commit.id + ' · ' + commit.message;
      root.GitGraphViewer.renderCommit(this.commitDetailBody, commit, { commits: snapshot.commits, remote: { commits: {} } });
      this.commitDetails.hidden = false; this.commitDetails.focus();
    }

    renderDirectory(snapshot) {
      const make = this.make, list = make('div', 'repo-file-list'); list.setAttribute('aria-label', '已提交文件列表');
      const heading = make('div', 'repo-list-heading'); heading.append(make('span', '', '名称'), make('span', '', '最近提交'), make('span', '', '提交时间'), make('span', '', '大小')); list.append(heading);
      if (snapshot.directory) list.append(this.button('↑ 返回上级目录', () => this.navigate(snapshot.directory.split('/').slice(0, -1).join('/')), 'repo-parent'));
      for (const entry of snapshot.entries) {
        const row = make('div', 'repo-file-row'), name = this.button('', () => this.navigate(entry.path), 'repo-entry-name');
        name.setAttribute('aria-label', (entry.directory ? '打开目录 ' : '查看文件 ') + entry.name);
        name.title = entry.name + (entry.directory ? ' · 目录' : ' · 文本文件 · ' + entry.bytes + ' B');
        const icon = make('span', entry.directory ? 'repo-folder-icon' : 'repo-file-icon', entry.directory ? '▰' : '▤'); icon.setAttribute('aria-hidden', 'true');
        name.append(icon, make('span', '', entry.name));
        const change = entry.lastCommit ? this.commitButton(entry.lastCommit, snapshot) : make('span', 'repo-history-missing', '历史记录不完整');
        row.append(name, change, this.commitTime(entry.lastCommit), make('span', 'repo-entry-size', entry.directory ? '—' : entry.bytes + ' B')); list.append(row);
      }
      if (!snapshot.entries.length) list.append(make('p', 'repo-empty', '此提交没有文件。'));
      this.content.append(list);
      // README 只做文本预览，文件内容始终不经过 HTML 或 Markdown 执行器。
      const readme = snapshot.entries.find(entry => !entry.directory && /^readme\.md$/i.test(entry.name));
      if (readme) {
        const preview = make('section', 'repo-readme'); preview.append(make('h3', '', readme.name + ' · 文本预览'), make('pre', '', snapshot.tree[readme.path])); this.content.append(preview);
      }
    }

    renderFile(snapshot) {
      const make = this.make, stats = fileStats(snapshot.tree[snapshot.file]), card = make('section', 'repo-file-card');
      const header = make('div', 'repo-file-header');
      header.append(make('strong', '', snapshot.file.split('/').at(-1)), make('span', '', stats.lines + ' 行 · ' + stats.bytes + ' B · 只读'), this.button('返回目录', () => this.navigate(snapshot.directory)));
      const history = make('div', 'repo-file-history');
      history.append(make('span', '', '最近提交'), snapshot.fileCommit ? this.commitButton(snapshot.fileCommit, snapshot) : make('span', 'repo-history-missing', '历史记录不完整'), this.commitTime(snapshot.fileCommit));
      const code = make('div', 'repo-code'); code.setAttribute('aria-label', '文件完整内容'); code.tabIndex = 0;
      stats.rows.forEach((text, i) => {
        const row = make('div', 'repo-code-line'), number = make('span', 'repo-line-number', String(i + 1)); number.setAttribute('aria-hidden', 'true');
        row.append(number, make('span', 'repo-line-text', text)); code.append(row);
      });
      if (!stats.rows.length) code.append(make('p', 'repo-empty', '空文件'));
      card.append(header, history, code); this.content.append(card);
    }
  }

  /** 同步数量只比较本地已下载对象，不能用远程实际状态提前得知 fetch 尚未下载的进度。 */
  function repositorySummary(state) {
    const branch = state.head.branch, id = branch ? state.branches[branch] : state.head.id;
    const upstream = branch && own(state.upstreams, branch) ? state.upstreams[branch] : null;
    const summary = { branch, id, upstream, ahead: null, behind: null, mode: branch ? 'unset' : 'detached', stashes: state.stashes.length };
    if (!branch || !upstream) return summary;
    summary.mode = 'unavailable';
    if (!own(state.tracking, upstream)) return summary;
    const ancestors = tip => {
      const seen = new Set(), stack = [tip];
      while (stack.length) {
        const current = stack.pop();
        if (seen.has(current)) continue;
        if (!own(state.commits, current)) return null;
        seen.add(current); stack.push(...state.commits[current].parents);
      }
      return seen;
    };
    const local = ancestors(id), remote = ancestors(state.tracking[upstream]);
    if (!local || !remote) return summary;
    summary.ahead = [...local].filter(commit => !remote.has(commit)).length;
    summary.behind = [...remote].filter(commit => !local.has(commit)).length;
    summary.mode = 'ready';
    return summary;
  }

  /** 常驻信息跟随当前身份，stash 与上游数量只读取该身份的本地仓库。 */
  class StatusView {
    constructor(panel, onCommand) {
      this.panel = panel;
      const make = (tag, className) => { const item = document.createElement(tag); item.className = className; return item; };
      this.root = make('section', 'repository-status'); this.root.id = 'repository-status'; this.root.setAttribute('aria-label', '本地仓库状态');
      const header = make('div', 'repository-status-heading'); this.label = make('strong', ''); this.label.textContent = '我的本地仓库';
      this.branch = make('span', 'repository-status-branch');
      this.stash = make('button', 'repository-status-stash'); this.stash.type = 'button';
      this.stash.title = '点击填入 git stash list，再按 Enter 查看临时保存记录';
      this.stash.addEventListener('click', () => onCommand('git stash list'));
      header.append(this.label, this.branch, this.stash);
      this.upstream = make('p', 'repository-status-upstream'); this.upstream.setAttribute('aria-live', 'polite');
      this.sync = make('p', 'repository-status-sync');
      this.root.append(header, this.upstream, this.sync); panel.querySelector('.panel-heading').after(this.root);
    }

    update(state, actor = 'local') {
      const summary = repositorySummary(state);
      const remote = actor === 'remote';
      this.label.textContent = remote ? '协作者本地仓库' : '我的本地仓库';
      this.root.setAttribute('aria-label', remote ? '协作者本地仓库状态' : '本地仓库状态');
      this.root.setAttribute('data-state', summary.mode);
      this.branch.textContent = summary.branch ? '分支：' + summary.branch : '分离 HEAD：' + summary.id;
      this.stash.textContent = (remote ? '协作者' : '本地') + ' Stash：' + summary.stashes;
      this.stash.setAttribute('aria-label', '查看' + (remote ? '协作者' : '本地') + ' Stash，共 ' + summary.stashes + ' 份');
      const texts = {
        detached: ['上游：分离 HEAD，无当前分支', '可以先创建或切换到本地分支，再关联上游。'],
        unset: ['上游：未设置', '首次推送并关联：git push -u origin ' + summary.branch],
        unavailable: ['上游：origin/' + summary.upstream, '本地暂无完整跟踪记录，无法计算领先 / 落后；请先 fetch 检查。'],
        ready: ['上游：origin/' + summary.upstream + ' · 领先 ' + summary.ahead + ' 个提交 · 落后 ' + summary.behind + ' 个提交', '数量依据本地远程跟踪引用，fetch 后更新；远程实际进度可能不同。']
      };
      const [upstream, sync] = texts[summary.mode];
      if (this.upstream.textContent !== upstream) this.upstream.textContent = upstream;
      this.sync.textContent = sync;
    }

    /** 重复点击替换当前高亮；减少动画设置下仅保留现有滚动与焦点定位。 */
    highlightCollaborator() {
      this.highlight?.cancel();
      this.highlight = null;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || !this.panel.animate) return;
      this.highlight = this.panel.animate([
        { outline: '3px solid transparent', outlineOffset: '-3px' },
        { outline: '3px solid #0d9488', outlineOffset: '-3px', offset: .25 },
        { outline: '3px solid transparent', outlineOffset: '-3px' }
      ], { duration: 1000, easing: 'ease-out' });
    }
  }

  /** 只读对比共享远程与当前身份的跟踪引用；更新数据时保留用户的展开选择。 */
  class SyncView {
    constructor(panel) {
      this.panel = panel; this.panel.open = false;
      const doc = panel.ownerDocument || document;
      this.make = (tag, text, className) => { const item = doc.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
      const make = this.make, summary = make('summary');
      this.owner = make('span', '', 'remote-sync-owner');
      summary.append(make('strong', '远程同步状态'), this.owner);
      this.table = make('table');
      const heading = make('tr'); this.trackingHeading = make('th');
      for (const cell of [make('th', '分支'), make('th', '共享远程'), this.trackingHeading]) { cell.setAttribute('scope', 'col'); heading.append(cell); }
      const head = make('thead'); head.append(heading); this.rows = make('tbody'); this.table.append(head, this.rows);
      this.note = make('p', '', 'remote-sync-note');
      this.panel.replaceChildren(summary, this.table, this.note);
    }

    update(state, actor = 'local') {
      const make = this.make, owner = actor === 'remote' ? '协作者本地' : '我的本地';
      this.owner.textContent = owner; this.trackingHeading.textContent = actor === 'remote' ? '协作者 origin/*' : '我的 origin/*';
      this.table.setAttribute('aria-label', owner + '的远程同步状态');
      this.note.textContent = 'origin/* 是' + owner + '保存的远程记录，fetch 后更新；push 更新共享远程，pull 进一步整合本地分支。';
      this.rows.replaceChildren();
      const branches = [...new Set([...Object.keys(state.remote.branches), ...Object.keys(state.tracking)])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      for (const branch of branches) {
        const actual = own(state.remote.branches, branch) ? state.remote.branches[branch] : null;
        const tracking = own(state.tracking, branch) ? state.tracking[branch] : null;
        const row = make('tr'), name = make('th', branch); name.setAttribute('scope', 'row');
        const remoteCell = make('td'), localCell = make('td');
        remoteCell.append(make('code', actual || '不存在')); localCell.append(make('code', tracking || '尚未获取'));
        if (actual !== tracking) localCell.append(make('span', '未同步', 'remote-sync-stale'));
        row.append(name, remoteCell, localCell); this.rows.append(row);
      }
      if (!branches.length) { const row = make('tr'), cell = make('td', '暂无远程分支或跟踪记录。'); cell.colSpan = 3; row.append(cell); this.rows.append(row); }
    }

    reset() { this.panel.open = false; }
  }

  const api = { Model, View, StatusView, SyncView, repositorySummary, fileStats, listEntries, references, latestPathCommit, commitAge };
  if (typeof module !== 'undefined' && module.exports) module.exports = { RepositoryBrowser: api };
  else root.GitRepositoryBrowser = api;
})(globalThis);
