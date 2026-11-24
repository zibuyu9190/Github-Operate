/* 常驻仓库状态与远程同步只读对比；仅统计本地已下载对象，不提前读取远端未同步进度。 */
(function (root) {
  'use strict';

  const { ACTORS } = typeof module !== 'undefined' && module.exports ? require('./simulator.js') : root.GitSimulator;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  /** 状态视图只接受已注册的仓库身份，避免把某个仓库误标给其他身份。 */
  function actorOwner(actor) {
    if (!own(ACTORS, actor)) throw new TypeError('未知的仓库身份。');
    return ACTORS[actor].owner;
  }

  /** 同步数量只比较本地已下载对象，不能用远程实际状态提前得知 fetch 尚未下载的进度。 */
  function repositorySummary(state) {
    const branch = state.head.branch;
    const id = branch ? state.branches[branch] : state.head.id;
    const upstream = branch && own(state.upstreams, branch) ? state.upstreams[branch] : null;
    const summary = {
      branch,
      id,
      upstream,
      ahead: null,
      behind: null,
      mode: branch ? 'unset' : 'detached',
      stashes: state.stashes.length
    };
    if (!branch || !upstream) return summary;
    summary.mode = 'unavailable';
    if (!own(state.tracking, upstream)) return summary;

    const ancestors = tip => {
      const seen = new Set();
      const stack = [tip];
      while (stack.length) {
        const current = stack.pop();
        if (seen.has(current)) continue;
        if (!own(state.commits, current)) return null;
        seen.add(current);
        stack.push(...state.commits[current].parents);
      }
      return seen;
    };

    const local = ancestors(id);
    const remote = ancestors(state.tracking[upstream]);
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
      const make = (tag, className) => {
        const item = document.createElement(tag);
        item.className = className;
        return item;
      };
      this.root = make('section', 'repository-status');
      this.root.id = 'repository-status';
      this.root.setAttribute('aria-label', '本地仓库状态');

      const header = make('div', 'repository-status-heading');
      this.label = make('strong', '');
      this.label.textContent = '我的本地仓库';
      this.branch = make('span', 'repository-status-branch');
      this.stash = make('button', 'repository-status-stash');
      this.stash.type = 'button';
      this.stash.title = '点击填入 git stash list，再按 Enter 查看临时保存记录';
      this.stash.addEventListener('click', () => onCommand('git stash list'));
      header.append(this.label, this.branch, this.stash);

      this.upstream = make('p', 'repository-status-upstream');
      this.upstream.setAttribute('aria-live', 'polite');
      this.sync = make('p', 'repository-status-sync');
      this.root.append(header, this.upstream, this.sync);
      panel.querySelector('.panel-heading').after(this.root);
    }

    update(state, actor = 'local') {
      const owner = actorOwner(actor);
      const summary = repositorySummary(state);
      const role = actor === 'local' ? '本地' : owner;
      this.label.textContent = owner + '本地仓库';
      this.root.setAttribute('aria-label', (actor === 'local' ? '本地仓库' : this.label.textContent) + '状态');
      this.root.setAttribute('data-state', summary.mode);
      this.branch.textContent = summary.branch ? '分支：' + summary.branch : '分离 HEAD：' + summary.id;
      this.stash.textContent = role + ' Stash：' + summary.stashes;
      this.stash.setAttribute('aria-label', '查看' + role + ' Stash，共 ' + summary.stashes + ' 份');
      const texts = {
        detached: ['上游：分离 HEAD，无当前分支', '可以先创建或切换到本地分支，再关联上游。'],
        unset: ['上游：未设置', '首次推送并关联：git push -u origin ' + summary.branch],
        unavailable: ['上游：origin/' + summary.upstream, '本地暂无完整跟踪记录，无法计算领先 / 落后；请先 fetch 检查。'],
        ready: [
          '上游：origin/' + summary.upstream + ' · 领先 ' + summary.ahead + ' 个提交 · 落后 ' + summary.behind + ' 个提交',
          '数量依据本地远程跟踪引用，fetch 后更新；远程实际进度可能不同。'
        ]
      };
      const [upstream, sync] = texts[summary.mode];
      if (this.upstream.textContent !== upstream) this.upstream.textContent = upstream;
      this.sync.textContent = sync;
    }
  }

  /** 只读对比共享远程与当前身份的跟踪引用；更新数据时保留用户的展开选择。 */
  class SyncView {
    constructor(panel) {
      this.panel = panel;
      this.panel.open = false;
      const doc = panel.ownerDocument || document;
      this.make = (tag, text, className) => {
        const item = doc.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
      };
      const make = this.make;
      const summary = make('summary');
      this.owner = make('span', '', 'remote-sync-owner');
      summary.append(make('strong', '远程同步状态'), this.owner);
      this.table = make('table');
      const heading = make('tr');
      this.trackingHeading = make('th');
      for (const cell of [make('th', '分支'), make('th', '共享远程'), this.trackingHeading]) {
        cell.setAttribute('scope', 'col');
        heading.append(cell);
      }
      const head = make('thead');
      head.append(heading);
      this.rows = make('tbody');
      this.table.append(head, this.rows);
      this.note = make('p', '', 'remote-sync-note');
      this.panel.replaceChildren(summary, this.table, this.note);
    }

    update(state, actor = 'local') {
      const make = this.make;
      const role = actorOwner(actor);
      const owner = role + '本地';
      this.owner.textContent = owner;
      this.trackingHeading.textContent = role + ' origin/*';
      this.table.setAttribute('aria-label', owner + '的远程同步状态');
      this.note.textContent = 'origin/* 是' + owner + '保存的远程记录，fetch 后更新；push 更新共享远程，pull 进一步整合本地分支。';
      this.rows.replaceChildren();
      const branches = [...new Set([...Object.keys(state.remote.branches), ...Object.keys(state.tracking)])].sort((a, b) =>
        a.localeCompare(b, 'zh-CN')
      );
      for (const branch of branches) {
        const actual = own(state.remote.branches, branch) ? state.remote.branches[branch] : null;
        const tracking = own(state.tracking, branch) ? state.tracking[branch] : null;
        const row = make('tr');
        const name = make('th', branch);
        name.setAttribute('scope', 'row');
        const remoteCell = make('td');
        const localCell = make('td');
        remoteCell.append(make('code', actual || '不存在'));
        localCell.append(make('code', tracking || '尚未获取'));
        if (actual !== tracking) localCell.append(make('span', '未同步', 'remote-sync-stale'));
        row.append(name, remoteCell, localCell);
        this.rows.append(row);
      }
      if (!branches.length) {
        const row = make('tr');
        const cell = make('td', '暂无远程分支或跟踪记录。');
        cell.colSpan = 3;
        row.append(cell);
        this.rows.append(row);
      }
    }

    reset() {
      this.panel.open = false;
    }
  }

  const api = { repositorySummary, StatusView, SyncView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitRepositoryStatus = api;
})(globalThis);
