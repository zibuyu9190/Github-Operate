/* 浏览已提交快照，不执行命令、不保存编辑草稿，也不提前同步远程引用。 */
(function (root) {
  'use strict';

  const { ACTORS } = typeof module !== 'undefined' && module.exports ? require('./simulator.js') : root.GitSimulator;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const SOURCES = {
    remote: '远程仓库 · origin',
    local: '本地仓库',
    tracking: '本地远程跟踪 · origin/*'
  };

  function getGraphViewer() {
    const viewer = (typeof module !== 'undefined' && module.exports ? require('./graph-viewer.js') : null) || root.GitGraphViewer;
    if (!viewer?.renderCommit) {
      throw new Error('缺少 GitGraphViewer.renderCommit 渲染器。');
    }
    return viewer;
  }

  function fileStats(text) {
    const rows = text ? text.split('\n') : [];
    if (rows.at(-1) === '') rows.pop();
    return { lines: rows.length, bytes: new TextEncoder().encode(text).length, rows };
  }

  /** 用路径分段区分目录边界，Map 避免普通文件名与对象原型属性冲突。 */
  function listEntries(tree, directory = '') {
    const prefix = directory ? directory + '/' : '';
    const entries = new Map();
    for (const path of Object.keys(tree)) {
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      const split = relative.indexOf('/');
      if (!relative) continue;
      const name = split < 0 ? relative : relative.slice(0, split);
      const target = prefix + name;
      if (!entries.has(name)) {
        entries.set(name, {
          name,
          path: target,
          directory: split >= 0,
          ...(split < 0 ? fileStats(tree[path]) : {})
        });
      }
    }
    return [...entries.values()].sort(
      (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN')
    );
  }

  /** 按路径简化历史：合并结果沿内容相同的父提交追溯，避免把导入的文件都误记为合并提交。 */
  function latestPathCommit(commits, tip, path, directory = false) {
    if (
      !own(commits, tip) ||
      !(directory
        ? Object.keys(commits[tip].tree).some(file => file.startsWith(path + '/'))
        : own(commits[tip].tree, path))
    ) {
      return null;
    }
    const samePath = (a, b) => {
      if (!directory) return own(a, path) === own(b, path) && a[path] === b[path];
      const prefix = path + '/';
      const paths = new Set([...Object.keys(a), ...Object.keys(b)].filter(file => file.startsWith(prefix)));
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
    if (!Number.isFinite(timestamp) || timestamp <= 0 || Number.isNaN(new Date(timestamp).getTime())) {
      return '时间未记录';
    }
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
    const refs = Object.entries(branches)
      .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
      .map(([name, id]) => ({ key: 'branch:' + name, name, id }));
    if (source === 'local' && !state.head.branch) {
      refs.unshift({ key: 'head:', name: 'HEAD（分离状态）', id: state.head.id });
    }
    return refs;
  }

  class Model {
    constructor(source = 'remote') {
      this.source = source;
      this.reference = '';
      this.directory = '';
      this.file = null;
    }

    /** 分支前进后重新读取快照；文件被删除时退回最近仍存在的目录，不展示旧文件内容。 */
    read(state) {
      const refs = references(state, this.source);
      let ref = refs.find(item => item.key === this.reference);
      if (!ref) {
        ref =
          refs.find(item => this.source === 'local' && (state.head.branch ? item.name === state.head.branch : item.key === 'head:')) ||
          refs.find(item => item.name === 'main') ||
          refs[0];
        this.reference = ref?.key || '';
      }
      const commits = this.source === 'remote' ? state.remote.commits : state.commits;
      const commit = ref && own(commits, ref.id) ? commits[ref.id] : null;
      const tree = commit?.tree || {};
      let notice = '';
      if (this.file && !own(tree, this.file)) {
        this.file = null;
        notice = '该文件在当前版本中不存在，已返回目录。';
      }
      while (this.directory && !Object.keys(tree).some(path => path.startsWith(this.directory + '/'))) {
        this.directory = this.directory.split('/').slice(0, -1).join('/');
      }
      const entries = listEntries(tree, this.directory).map(entry => ({
        ...entry,
        lastCommit: latestPathCommit(commits, ref.id, entry.path, entry.directory)
      }));
      const fileCommit = this.file ? latestPathCommit(commits, ref.id, this.file) : null;
      return {
        source: this.source,
        refs,
        ref,
        commit,
        commits,
        tree,
        directory: this.directory,
        file: this.file,
        entries,
        fileCommit,
        total: Object.keys(tree).length,
        notice
      };
    }

    selectSource(source, state) {
      const available = references(state, source);
      const name = references(state, this.source).find(ref => ref.key === this.reference)?.name;
      this.source = source;
      this.reference = available.find(ref => ref.name === name)?.key || '';
      return this.read(state);
    }

    selectReference(key, state) {
      if (!references(state, this.source).some(ref => ref.key === key)) {
        throw new Error('该分支在当前查看位置不存在。');
      }
      this.reference = key;
      return this.read(state);
    }

    openPath(path, state) {
      const snapshot = this.read(state);
      if (own(snapshot.tree, path)) {
        this.file = path;
        this.directory = path.split('/').slice(0, -1).join('/');
      } else if (path === '' || Object.keys(snapshot.tree).some(file => file.startsWith(path + '/'))) {
        this.file = null;
        this.directory = path;
      } else {
        return false;
      }
      return true;
    }
  }

  class View {
    /** 原生 dialog 负责焦点范围与 Esc；关闭后还原入口焦点，不重建现有文件编辑器。 */
    constructor(readContext, beforeOpen) {
      this.readContext = readContext;
      this.beforeOpen = beforeOpen;
      this.actor = 'local';
      this.model = new Model('local');
      this.models = new Map([[this.actor, this.model]]);

      const make = (tag, className, text) => {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
      };
      this.make = make;
      this.button = (text, action, className = 'repo-button') => {
        const item = make('button', className, text);
        item.type = 'button';
        item.addEventListener('click', action);
        return item;
      };

      this.trigger = this.button('仓库浏览', () => this.open(), 'button quiet repository-trigger');
      this.trigger.id = 'repository-open';
      this.trigger.setAttribute('aria-haspopup', 'dialog');
      this.trigger.setAttribute('aria-controls', 'repository-browser');
      document.getElementById('help-button').before(this.trigger);

      this.dialog = make('dialog', 'repository-browser');
      this.dialog.id = 'repository-browser';
      this.dialog.setAttribute('aria-labelledby', 'repository-title');
      this.dialog.setAttribute('aria-describedby', 'repository-hint');

      const header = make('header', 'repo-header');
      const identity = make('div', 'repo-identity');
      this.actorBadge = make('span', 'repo-badge');
      identity.append(make('span', 'repo-symbol', '▣'), make('h2', '', 'Git Playground'), this.actorBadge);
      identity.querySelector('h2').id = 'repository-title';
      const tab = make('div', 'repo-code-tab');
      tab.append(make('strong', '', '〈〉代码'), make('span', '', '浏览已提交文件'));
      const headerActions = make('div', 'repo-header-actions');
      this.count = make('span', 'repo-file-count');
      this.closeButton = this.button('关闭', () => this.dialog.close());
      this.closeButton.setAttribute('aria-label', '关闭仓库浏览');
      headerActions.append(this.count, this.closeButton);
      header.append(identity, tab, headerActions);

      const toolbar = make('div', 'repo-toolbar');
      const controls = make('div', 'repo-controls');
      this.sourceSelect = make('select');
      this.sourceSelect.id = 'repository-source';
      for (const [key, value] of Object.entries(SOURCES)) {
        const option = make('option', '', value);
        option.value = key;
        this.sourceSelect.append(option);
      }
      this.branchSelect = make('select');
      this.branchSelect.id = 'repository-branch';
      for (const [label, select] of [['查看位置', this.sourceSelect], ['分支', this.branchSelect]]) {
        const group = make('div', 'repo-control');
        const caption = make('label', '', label);
        caption.htmlFor = select.id;
        group.append(caption, select);
        controls.append(group);
      }
      this.sourceSelect.addEventListener('change', () => {
        const { state } = this.context();
        this.render(this.model.selectSource(this.sourceSelect.value, state));
      });
      this.branchSelect.addEventListener('change', () => {
        const { state } = this.context();
        this.render(this.model.selectReference(this.branchSelect.value, state));
      });
      this.breadcrumb = make('nav', 'repo-breadcrumb');
      this.breadcrumb.setAttribute('aria-label', '仓库文件路径');
      this.hint = make('p', 'repo-hint');
      this.hint.id = 'repository-hint';
      toolbar.append(controls, this.breadcrumb, this.hint);

      this.notice = make('p', 'repo-notice');
      this.notice.setAttribute('role', 'status');
      this.commit = make('div', 'repo-latest');
      this.content = make('div', 'repo-content');
      this.content.tabIndex = -1;
      this.main = make('div', 'repo-main');
      this.main.append(this.commit, this.content);

      this.commitDetails = make('section', 'repo-commit-details');
      this.commitDetails.hidden = true;
      this.commitDetails.tabIndex = -1;
      this.commitDetails.setAttribute('aria-label', '提交详情');
      this.commitDetailTitle = make('h3');
      this.commitDetailBody = make('div', 'repo-commit-body');
      const detailHeader = make('div', 'repo-commit-header');
      detailHeader.append(
        this.commitDetailTitle,
        this.button('收起提交详情', () => {
          this.commitDetails.hidden = true;
          this.syncSide();
          (this.commitReturnFocus?.isConnected ? this.commitReturnFocus : this.branchSelect).focus();
        })
      );
      this.commitDetails.append(detailHeader, this.commitDetailBody);

      this.readme = make('section', 'repo-readme');
      this.readme.hidden = true;
      this.side = make('aside', 'repo-side');
      this.side.hidden = true;
      this.side.append(this.commitDetails, this.readme);
      this.body = make('div', 'repo-body');
      this.body.append(this.main, this.side);
      this.dialog.append(header, toolbar, this.notice, this.body);
      document.body.append(this.dialog);

      this.dialog.addEventListener('close', () => {
        // 原生 close 事件可能延迟到再次打开后才派发，此时保留新弹窗的滚动锁与焦点。
        if (this.dialog.open) return;
        document.body.classList.remove('repository-browser-open');
        if (this.previousFocus?.isConnected) this.previousFocus.focus();
      });
      this.dialog.addEventListener('click', event => {
        if (event.target !== this.dialog) return;
        const rect = this.dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
          this.dialog.close();
        }
      });
    }

    /** 浏览状态按身份隔离；切换只读取该方快照，不执行同步或修改任何仓库。 */
    context() {
      const context = this.readContext();
      const actor = own(ACTORS, context.actor) ? context.actor : 'local';
      if (actor !== this.actor) {
        this.actor = actor;
        if (!this.models.has(actor)) this.models.set(actor, new Model('local'));
        this.model = this.models.get(actor);
      }
      return { ...context, actor };
    }

    reset() {
      this.actor = 'local';
      this.model = new Model('local');
      this.models = new Map([[this.actor, this.model]]);
      if (this.dialog.open) this.render();
    }

    open() {
      if (this.dialog.open) return;
      this.beforeOpen();
      this.previousFocus = document.activeElement;
      this.render();
      document.body.classList.add('repository-browser-open');
      this.dialog.showModal();
      this.branchSelect.focus();
    }

    navigate(path) {
      const { state } = this.context();
      if (!this.model.openPath(path, state)) return;
      this.render();
      this.content.focus();
      this.content.parentElement.scrollTop = 0;
    }

    syncSide() {
      const hasSide = !this.commitDetails.hidden || !this.readme.hidden;
      this.side.hidden = !hasSide;
      if (hasSide) this.body.classList.add('has-side');
      else this.body.classList.remove('has-side');
    }

    render(snapshot) {
      const { state, actor } = this.context();
      const make = this.make;
      snapshot = snapshot || this.model.read(state);
      const { owner } = ACTORS[actor];
      this.actorBadge.textContent = '虚拟仓库 · ' + (actor === 'local' ? '我的本地' : owner) + '视角';
      const sources = {
        remote: '共享远程仓库 · origin',
        local: owner + '本地仓库',
        tracking: owner + '远程跟踪 · origin/*'
      };
      for (const option of this.sourceSelect.children) {
        option.textContent = sources[option.value];
      }
      this.sourceSelect.value = snapshot.source;
      this.branchSelect.replaceChildren(
        ...snapshot.refs.map(ref => {
          const option = make('option', '', ref.name);
          option.value = ref.key;
          return option;
        })
      );
      this.branchSelect.value = snapshot.ref?.key || '';
      this.branchSelect.disabled = !snapshot.refs.length;
      this.count.textContent = snapshot.total + ' 个已提交文件';

      const meanings = {
        remote: '这里是共享远程已接收的文件；任一身份 push 后即可查看。',
        local: '这里是' + owner + '本地分支已提交的文件；工作区和暂存区中的未提交改动不在此显示。',
        tracking: '这里是' + owner + '本地记录的远程版本；该身份 fetch 更新跟踪引用，pull 才进一步整合本地分支。'
      };
      this.hint.textContent = meanings[snapshot.source] + ' 此视图只读，切换查看不会切换 HEAD 或改动草稿。';
      this.notice.textContent = snapshot.notice;
      this.notice.hidden = !snapshot.notice;

      this.commit.replaceChildren();
      this.breadcrumb.replaceChildren();
      this.content.replaceChildren();
      this.commitDetails.hidden = true;
      this.commitDetailBody.replaceChildren();
      this.readme.hidden = true;
      this.readme.replaceChildren();

      if (!snapshot.commit) {
        this.commit.hidden = true;
        this.syncSide();
        this.content.append(
          make(
            'p',
            'repo-empty',
            snapshot.ref ? '当前提交对象不可用，请先同步对应的本地记录。' : '此位置暂无分支。可在本地创建分支并 push 后查看远程仓库。'
          )
        );
        return;
      }

      this.commit.hidden = false;
      this.commit.append(
        make('span', 'repo-commit-icon', '●'),
        this.commitButton(snapshot.commit, snapshot),
        this.commitTime(snapshot.commit)
      );
      this.breadcrumb.append(this.button('Git Playground', () => this.navigate(''), 'repo-path-button'));

      const parts = (snapshot.file || snapshot.directory).split('/').filter(Boolean);
      parts.forEach((part, i) => {
        this.breadcrumb.append(make('span', 'repo-path-separator', '/'));
        if (snapshot.file && i === parts.length - 1) {
          const current = make('span', 'repo-current-path', part);
          current.setAttribute('aria-current', 'page');
          this.breadcrumb.append(current);
        } else {
          this.breadcrumb.append(this.button(part, () => this.navigate(parts.slice(0, i + 1).join('/')), 'repo-path-button'));
        }
      });

      if (snapshot.file) this.renderFile(snapshot);
      else this.renderDirectory(snapshot);
      this.syncSide();
    }

    commitTime(commit) {
      const timestamp = commit?.timestamp;
      const age = commitAge(timestamp);
      const time = this.make('time', 'repo-entry-time', age);
      if (age !== '时间未记录') {
        time.dateTime = new Date(timestamp).toISOString();
        time.title = new Date(timestamp).toLocaleString('zh-CN');
      }
      return time;
    }

    commitButton(commit, snapshot) {
      const button = this.button('', () => this.showCommit(commit, snapshot, button), 'repo-commit-link');
      button.setAttribute('aria-label', '查看提交 ' + commit.id + '：' + commit.message);
      button.title = commit.message + ' · ' + commit.id;
      button.append(
        this.make('span', 'repo-commit-message', commit.message.split(/\r?\n/)[0]),
        this.make('code', 'repo-commit-id', commit.id)
      );
      return button;
    }

    /** 详情只读取当前查看来源的提交对象，打开和收起都不移动 HEAD 或覆盖编辑草稿。 */
    showCommit(commit, snapshot, trigger) {
      this.commitReturnFocus = trigger;
      this.commitDetailTitle.textContent = commit.id + ' · ' + commit.message;
      getGraphViewer().renderCommit(this.commitDetailBody, commit, { commits: snapshot.commits, remote: { commits: {} } });
      this.commitDetails.hidden = false;
      this.syncSide();
      this.commitDetails.focus();
    }

    renderDirectory(snapshot) {
      const make = this.make;
      const list = make('div', 'repo-file-list');
      list.setAttribute('aria-label', '已提交文件列表');
      const heading = make('div', 'repo-list-heading');
      heading.append(make('span', '', '名称'), make('span', '', '最近提交'), make('span', '', '提交时间'), make('span', '', '大小'));
      list.append(heading);
      if (snapshot.directory) {
        list.append(
          this.button(
            '↑ 返回上级目录',
            () => this.navigate(snapshot.directory.split('/').slice(0, -1).join('/')),
            'repo-parent'
          )
        );
      }
      for (const entry of snapshot.entries) {
        const row = make('div', 'repo-file-row');
        const name = this.button('', () => this.navigate(entry.path), 'repo-entry-name');
        name.setAttribute('aria-label', (entry.directory ? '打开目录 ' : '查看文件 ') + entry.name);
        name.title = entry.name + (entry.directory ? ' · 目录' : ' · 文本文件 · ' + entry.bytes + ' B');
        const icon = make('span', entry.directory ? 'repo-folder-icon' : 'repo-file-icon', entry.directory ? '▰' : '▤');
        icon.setAttribute('aria-hidden', 'true');
        name.append(icon, make('span', '', entry.name));
        const change = entry.lastCommit
          ? this.commitButton(entry.lastCommit, snapshot)
          : make('span', 'repo-history-missing', '历史记录不完整');
        row.append(
          name,
          change,
          this.commitTime(entry.lastCommit),
          make('span', 'repo-entry-size', entry.directory ? '—' : entry.bytes + ' B')
        );
        list.append(row);
      }
      if (!snapshot.entries.length) {
        list.append(make('p', 'repo-empty', '此提交没有文件。'));
      }
      this.content.append(list);

      // README 只做文本预览，文件内容始终不经过 HTML 或 Markdown 执行器。
      const readme = snapshot.entries.find(entry => !entry.directory && /^readme\.md$/i.test(entry.name));
      if (readme) {
        this.readme.append(make('h3', '', readme.name + ' · 文本预览'), make('pre', '', snapshot.tree[readme.path]));
        this.readme.hidden = false;
      }
    }

    renderFile(snapshot) {
      const make = this.make;
      const stats = fileStats(snapshot.tree[snapshot.file]);
      const card = make('section', 'repo-file-card');
      const header = make('div', 'repo-file-header');
      header.append(
        make('strong', '', snapshot.file.split('/').at(-1)),
        make('span', '', stats.lines + ' 行 · ' + stats.bytes + ' B · 只读'),
        this.button('返回目录', () => this.navigate(snapshot.directory))
      );
      const history = make('div', 'repo-file-history');
      history.append(
        make('span', '', '最近提交'),
        snapshot.fileCommit
          ? this.commitButton(snapshot.fileCommit, snapshot)
          : make('span', 'repo-history-missing', '历史记录不完整'),
        this.commitTime(snapshot.fileCommit)
      );
      const code = make('div', 'repo-code');
      code.setAttribute('aria-label', '文件完整内容');
      code.tabIndex = 0;
      stats.rows.forEach((text, i) => {
        const row = make('div', 'repo-code-line');
        const number = make('span', 'repo-line-number', String(i + 1));
        number.setAttribute('aria-hidden', 'true');
        row.append(number, make('span', 'repo-line-text', text));
        code.append(row);
      });
      if (!stats.rows.length) {
        code.append(make('p', 'repo-empty', '空文件'));
      }
      card.append(header, history, code);
      this.content.append(card);
    }
  }

  const api = { Model, View, fileStats, listEntries, references, latestPathCommit, commitAge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitRepositoryBrowser = api;
})(globalThis);
