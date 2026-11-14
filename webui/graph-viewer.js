/* 放大查看复用原 SVG：只移动画布，不复制提交图，也不读写虚拟仓库。 */
(function (root) {
  'use strict';

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
        container.append(make('p', 'commit-diff-legend', '本次改动 · ' + (parentId ? '相对第一父提交 ' + parentId : '相对空仓库') + ' · + 绿色新增 / − 红色删除'));
        if (!changed.length) container.append(make('p', '', '本次提交没有文件内容变化。'));
        for (const path of changed) {
          const before = textAt(baseline, path), after = textAt(commit.tree, path);
          const section = make('div', 'commit-change');
          section.append(make('strong', 'commit-change-title', (before === undefined ? '新增' : after === undefined ? '删除' : '修改') + ' · ' + path));
          const preview = make('pre', 'commit-diff'), original = (before || '').match(/[^\n]*\n|[^\n]+$/g) || [];
          const changes = root.GitSimulator.edits(before, after);
          for (const change of changes) {
            preview.append(make('span', 'commit-diff-line commit-diff-hunk', '@@ 原文件第 ' + (change.start + 1) + ' 行 @@'));
            for (const line of original.slice(change.start, change.end)) preview.append(make('span', 'commit-diff-line commit-diff-removed', '− ' + line.replace(/\n$/, '')));
            for (const line of change.lines) preview.append(make('span', 'commit-diff-line commit-diff-added', '+ ' + line.replace(/\n$/, '')));
          }
          if (!changes.length) preview.append(make('span', 'commit-diff-line', after === undefined ? '删除空文件' : '新增空文件'));
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
      tools.append(this.zoomOut, this.zoomLabel, this.zoomIn, button('适应画布', '适应大图画布', () => this.zoom(1)), this.closeButton);
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
      this.previous = { zoom: this.graph.zoom, left: this.stage.scrollLeft, top: this.stage.scrollTop, focus: document.activeElement };
      this.placeholder = document.createComment('提交图原位置'); this.stage.before(this.placeholder);
      this.canvas.append(this.stage);
      const context = this.readContext(); this.title.textContent = context.title + ' · 提交图';
      this.details.open = false; this.content.replaceChildren(); this.summary.textContent = '点击提交节点，查看说明与文件快照';
      document.body.classList.add('graph-viewer-open'); this.dialog.showModal();
      this.graph.draw(context.state); this.zoom(1); this.stage.scrollLeft = 0; this.stage.scrollTop = 0;
      if (showSelection && this.selected) this.showCommit(this.selected.commit, this.selected.remoteOnly);
    }

    zoom(value) {
      this.graph.setZoom(value); this.zoomLabel.textContent = Math.round(this.graph.zoom * 100) + '%';
      this.zoomOut.disabled = this.graph.zoom <= .6; this.zoomIn.disabled = this.graph.zoom >= 2.5;
    }

    /** 快照只用文本节点呈现，文件内容与提交说明不会作为 HTML 执行。 */
    showCommit(commit, remoteOnly) {
      this.summary.textContent = commit.id + ' · ' + commit.message + (remoteOnly ? '（仅远程）' : '');
      GraphViewer.renderCommit(this.content, commit, this.readContext().state);
      this.details.open = true;
      this.details.scrollTop = 0;
      this.graph.resize();
    }

    restore() {
      if (!this.placeholder) return;
      this.placeholder.replaceWith(this.stage); this.placeholder = null;
      document.body.classList.remove('graph-viewer-open'); this.graph.setZoom(this.previous.zoom);
      this.stage.scrollLeft = this.previous.left; this.stage.scrollTop = this.previous.top;
      const focus = this.previous.focus?.isConnected ? this.previous.focus : this.trigger;
      focus.focus({ preventScroll: true });
    }
  }

  root.GitGraphViewer = GraphViewer;
})(globalThis);
