/* 放大查看复用原 SVG：只移动画布，不复制提交图，也不读写虚拟仓库。 */
(function (root) {
  'use strict';

  function getEdits() {
    const simulator = root.GitSimulator || (typeof module !== 'undefined' && module.exports ? require('./simulator.js') : null);
    if (!simulator?.edits) {
      throw new Error('缺少 GitSimulator.edits 差异计算器。');
    }
    return simulator.edits;
  }

  /** 复用模拟器的行编辑结果；独立累计新旧行号，前后各保留三行上下文并合并相邻片段。 */
  function unifiedHunks(before, after) {
    const edits = getEdits();
    const original = (before || '').match(/[^\n]*\n|[^\n]+$/g) || [];
    const rows = [];
    let oldLine = 1;
    let newLine = 1;

    const append = (kind, text) => {
      rows.push({
        kind,
        text: text.replace(/\r?\n$/, ''),
        oldLine: kind === 'added' ? null : oldLine,
        newLine: kind === 'removed' ? null : newLine,
        oldCursor: oldLine,
        newCursor: newLine,
        noNewline: !text.endsWith('\n')
      });
      if (kind !== 'added') oldLine++;
      if (kind !== 'removed') newLine++;
    };

    for (const change of edits(before, after)) {
      while (oldLine <= change.start) {
        append('context', original[oldLine - 1]);
      }
      for (const text of original.slice(change.start, change.end)) {
        append('removed', text);
      }
      for (const text of change.lines) {
        append('added', text);
      }
    }
    while (oldLine <= original.length) {
      append('context', original[oldLine - 1]);
    }

    const ranges = [];
    rows.forEach((row, index) => {
      if (row.kind === 'context') return;
      const start = Math.max(0, index - 3);
      const end = Math.min(rows.length, index + 4);
      const last = ranges.at(-1);
      if (last && start <= last.end) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }
    });

    return ranges.map(({ start, end }) => {
      const content = rows.slice(start, end);
      const oldRows = content.filter(row => row.oldLine !== null);
      const newRows = content.filter(row => row.newLine !== null);
      // 空侧从插入/删除位置计数；新增文件必须显示 -0,0，删除文件则显示 +0,0。
      const range = (number, count) => (count === 1 ? String(number) : number + ',' + count);
      const oldStart = oldRows.length ? oldRows[0].oldLine : content[0].oldCursor - 1;
      const newStart = newRows.length ? newRows[0].newLine : content[0].newCursor - 1;
      return {
        header: '@@ -' + range(oldStart, oldRows.length) + ' +' + range(newStart, newRows.length) + ' @@',
        rows: content
      };
    });
  }

  class GraphViewer {
    /** 主页面与放大图共用差异视图；合并提交以第一父提交为基准，新增/删除同时用文字和颜色标明。 */
    static renderCommit(container, commit, state) {
      const make = (tag, className, text) => {
        const item = document.createElement(tag);
        item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
      };
      const parentId = commit.parents[0];
      const parent = state.commits[parentId] || state.remote.commits[parentId];
      container.replaceChildren(
        make('p', '', '模拟短 ID：' + commit.hash + ' · 父提交：' + (commit.parents.join('、') || '无（初始提交）'))
      );

      if (parentId && !parent) {
        container.append(make('p', '', '父提交快照不可用，请查看完整文件快照。'));
      } else {
        const baseline = parent?.tree || {};
        // 文件名可能与对象原型属性同名，只读取快照中实际存在的文件。
        const textAt = (tree, path) => (Object.prototype.hasOwnProperty.call(tree, path) ? tree[path] : undefined);
        const changed = [...new Set([...Object.keys(baseline), ...Object.keys(commit.tree)])]
          .sort()
          .filter(path => textAt(baseline, path) !== textAt(commit.tree, path));

        container.append(
          make(
            'p',
            'commit-diff-legend',
            '本次改动 · ' + (parentId ? '相对第一父提交 ' + parentId : '相对空仓库') + ' · 旧 / 新行号 · + 新增 / − 删除 · 白色为未修改上下文'
          )
        );
        if (!changed.length) {
          container.append(make('p', '', '本次提交没有文件内容变化。'));
        }

        for (const path of changed) {
          const before = textAt(baseline, path);
          const after = textAt(commit.tree, path);
          const section = make('div', 'commit-change');
          section.append(
            make('strong', 'commit-change-title', (before === undefined ? '新增' : after === undefined ? '删除' : '修改') + ' · ' + path)
          );
          const preview = make('div', 'commit-diff');
          preview.tabIndex = 0;
          preview.setAttribute('aria-label', path + ' 的提交差异');

          const table = make('table', 'commit-diff-table');
          const head = make('thead', '');
          const heading = make('tr', '');
          const body = make('tbody', '');
          ['旧行号', '新行号', '变化', '内容'].forEach((label, index) => {
            const cell = make('th', index < 2 ? 'commit-diff-number' : index === 2 ? 'commit-diff-sign' : 'commit-diff-code', label);
            cell.setAttribute('scope', 'col');
            heading.append(cell);
          });
          head.append(heading);
          table.append(head, body);
          preview.append(table);

          const hunks = unifiedHunks(before, after);
          for (const hunk of hunks) {
            const header = make('tr', 'commit-diff-hunk');
            const label = make('td', '', hunk.header);
            label.colSpan = 4;
            header.append(label);
            body.append(header);
            for (const line of hunk.rows) {
              const row = make('tr', 'commit-diff-row commit-diff-' + line.kind);
              row.append(
                make('td', 'commit-diff-number', line.oldLine === null ? '' : String(line.oldLine)),
                make('td', 'commit-diff-number', line.newLine === null ? '' : String(line.newLine)),
                make('td', 'commit-diff-sign', line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''),
                make('td', 'commit-diff-code', line.text)
              );
              body.append(row);
              if (line.noNewline) {
                const note = make('tr', 'commit-diff-note');
                const cell = make('td', '', '\\ 文件末尾没有换行');
                cell.colSpan = 4;
                note.append(cell);
                body.append(note);
              }
            }
          }
          if (!hunks.length) {
            preview.append(make('p', 'commit-diff-empty', after === undefined ? '删除空文件' : '新增空文件'));
          }
          section.append(preview);
          container.append(section);
        }
      }

      // 完整快照折叠保留，优先让用户看见本次变化；文件与说明始终只进入文本节点。
      const snapshot = make('details', 'commit-full-snapshot');
      snapshot.append(make('summary', '', '完整文件快照（' + Object.keys(commit.tree).length + ' 个文件）'));
      for (const [path, text] of Object.entries(commit.tree)) {
        snapshot.append(make('strong', '', path), make('pre', '', text || '（空文件）'));
      }
      if (!Object.keys(commit.tree).length) {
        snapshot.append(make('p', '', '空文件树'));
      }
      container.append(snapshot);
      container.scrollTop = 0;
    }

    constructor(graph, stage, readContext, beforeOpen) {
      this.graph = graph;
      this.stage = stage;
      this.readContext = readContext;
      this.beforeOpen = beforeOpen;

      const make = (tag, className, text) => {
        const item = document.createElement(tag);
        item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
      };
      this.make = make;

      const button = (text, label, action) => {
        const item = make('button', 'graph-viewer-button', text);
        item.type = 'button';
        item.setAttribute('aria-label', label);
        item.title = label;
        item.addEventListener('click', action);
        return item;
      };

      this.trigger = button('⛶ 放大查看', '放大查看提交图', () => this.open());
      this.trigger.id = 'graph-expand';
      this.trigger.setAttribute('aria-haspopup', 'dialog');
      this.trigger.setAttribute('aria-controls', 'graph-viewer');
      document.querySelector('.graph-tools').append(this.trigger);

      this.dialog = make('dialog', 'graph-viewer');
      this.dialog.id = 'graph-viewer';
      this.dialog.setAttribute('aria-labelledby', 'graph-viewer-title');
      this.dialog.setAttribute('aria-describedby', 'graph-viewer-hint');

      const header = make('header', 'graph-viewer-header');
      const heading = make('div', 'graph-viewer-heading');
      this.title = make('h2', '', '提交图 · 放大查看');
      this.title.id = 'graph-viewer-title';
      const hint = make('p', '', '点击提交节点查看快照 · 使用按钮缩放 · Esc 关闭');
      hint.id = 'graph-viewer-hint';
      heading.append(this.title, hint);

      const tools = make('div', 'graph-viewer-tools');
      this.zoomLabel = make('output', 'graph-viewer-scale', '100%');
      this.zoomLabel.setAttribute('aria-label', '大图缩放比例');
      this.zoomOut = button('−', '缩小大图', () => this.zoom(this.graph.zoom - 0.2));
      this.zoomIn = button('＋', '放大大图', () => this.zoom(this.graph.zoom + 0.2));
      this.defaultZoom = button('默认比例', '恢复大图默认缩放', () => this.zoom(root.CommitGraph.DEFAULT_ZOOM));
      this.closeButton = button('✕ 关闭', '关闭放大图', () => this.dialog.close());
      this.closeButton.autofocus = true;
      tools.append(
        this.zoomOut,
        this.zoomLabel,
        this.zoomIn,
        this.defaultZoom,
        button('适应画布', '适应大图画布', () => this.zoom()),
        this.closeButton
      );
      header.append(heading, tools);

      this.canvas = make('div', 'graph-viewer-canvas');
      this.details = make('details', 'graph-viewer-details');
      this.summary = make('summary', '', '点击提交节点，查看说明与文件快照');
      this.content = make('div', 'graph-viewer-snapshot');
      this.details.append(this.summary, this.content);
      this.dialog.append(header, this.canvas, this.details);
      document.body.append(this.dialog);

      // 保留原来的节点选择行为；大图中再就地显示快照，避免跳到弹窗后方。
      const select = graph.onSelect;
      graph.onSelect = (commit, remoteOnly) => {
        select(commit, remoteOnly);
        this.selected = { commit, remoteOnly };
        if (this.dialog.open) this.showCommit(commit, remoteOnly);
      };

      stage.classList.add('graph-expandable');
      stage.tabIndex = 0;
      stage.setAttribute('aria-label', '提交图，按 Enter 放大查看');
      stage.setAttribute('aria-haspopup', 'dialog');
      stage.setAttribute('aria-controls', this.dialog.id);
      stage.addEventListener('click', event => {
        if (this.dialog.open || window.getSelection()?.toString()) return;
        // 只在画布可见区域内触发放大。
        const rect = stage.getBoundingClientRect();
        if (event.clientX >= rect.left + stage.clientWidth || event.clientY >= rect.top + stage.clientHeight) return;
        this.open(Boolean(event.target.closest('.commit-node')));
      });
      stage.addEventListener('keydown', event => {
        if (event.target !== stage || !['Enter', ' '].includes(event.key) || this.dialog.open) return;
        event.preventDefault();
        this.open();
      });

      const caption = stage.querySelector('.canvas-caption');
      if (caption) caption.textContent = '点击提交图放大查看 · 点击节点查看快照';

      this.dialog.addEventListener('click', event => {
        if (event.target !== this.dialog) return;
        const rect = this.dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
          this.dialog.close();
        }
      });
      this.dialog.addEventListener('close', () => {
        if (!this.dialog.open) this.restore();
      });
    }

    /** 用占位符保存原位置，关闭后恢复主画布的缩放和焦点。 */
    open(showSelection = false) {
      if (this.dialog.open) return;
      // 原生 close 事件可能下一帧才到达；快速重开时先归位，避免占位符留在弹窗内部。
      if (this.placeholder) this.restore();
      this.beforeOpen();
      this.previous = {
        zoom: this.graph.zoom,
        fitted: this.graph.fitted,
        focus: document.activeElement
      };
      this.placeholder = document.createComment('提交图原位置');
      this.stage.before(this.placeholder);
      this.canvas.append(this.stage);
      const context = this.readContext();
      this.title.textContent = context.title + ' · 提交图';
      this.details.open = false;
      this.content.replaceChildren();
      this.summary.textContent = '点击提交节点，查看说明与文件快照';
      document.body.classList.add('graph-viewer-open');
      this.dialog.showModal();
      this.graph.draw(context.state);
      this.zoom(root.CommitGraph.DEFAULT_ZOOM);
      if (showSelection && this.selected) {
        this.showCommit(this.selected.commit, this.selected.remoteOnly);
      }
    }

    zoom(value) {
      if (value === undefined) this.graph.fit();
      else this.graph.setZoom(value);
      this.zoomLabel.textContent = this.graph.fitted ? '适应' : Math.round(this.graph.zoom * 100) + '%';
      this.zoomOut.disabled = !this.graph.canZoomOut;
      this.zoomIn.disabled = !this.graph.canZoomIn;
    }

    /** 选择只更新纯文本详情，默认折叠；保留用户通过标题手动展开或收起的状态。 */
    showCommit(commit, remoteOnly) {
      this.summary.textContent = commit.id + ' · ' + commit.message + (remoteOnly ? '（仅远程）' : '');
      GraphViewer.renderCommit(this.content, commit, this.readContext().state);
      this.details.scrollTop = 0;
    }

    restore() {
      if (!this.placeholder) return;
      this.placeholder.replaceWith(this.stage);
      this.placeholder = null;
      document.body.classList.remove('graph-viewer-open');
      if (this.previous.fitted) this.graph.fit();
      else this.graph.setZoom(this.previous.zoom);
      const focus = this.previous.focus?.isConnected ? this.previous.focus : this.trigger;
      focus.focus({ preventScroll: true });
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = GraphViewer;
  else root.GitGraphViewer = GraphViewer;
})(globalThis);
