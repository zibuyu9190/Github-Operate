(function (root) {
  'use strict';
  const Commands = typeof module !== 'undefined' && module.exports ? require('./commands.js') : root.GitCommands;
  const clone = value => JSON.parse(JSON.stringify(value));
  const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key);
  const value = (map, key) => own(map, key) ? map[key] : undefined;
  const keys = (...maps) => [...new Set(maps.flatMap(map => Object.keys(map)))].sort();
  const same = (a, b) => keys(a, b).every(path => value(a, path) === value(b, path));
  const lines = text => (text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
  const put = (tree, path, text) => { if (text === undefined) delete tree[path]; else tree[path] = text; };

  /** 普通文件快照不能同时包含文件及其子路径，避免恢复操作留下无法编辑的目录冲突。 */
  function checkTreePaths(tree) {
    const paths = Object.keys(tree);
    if (paths.some(p => paths.some(other => other.startsWith(p + '/')))) throw new Error('教学版暂不支持恢复时的文件与目录冲突，仓库状态保持不变。');
  }

  /** 查看命令共用逐行差异，快照始终只读；输出作为纯文本交给页面。 */
  function treeDiff(a, b) {
    const output = [];
    for (const path of keys(a, b)) {
      if (value(a, path) === value(b, path)) continue;
      output.push('--- ' + path + '\n+++ ' + path);
      for (const edit of edits(value(a, path), value(b, path))) {
        output.push('@@ 原文件行 ' + (edit.start + 1) + ' @@');
        output.push(...lines(value(a, path)).slice(edit.start, edit.end).map(x => '-' + x.replace(/\n$/, '')));
        output.push(...edit.lines.map(x => '+' + x.replace(/\n$/, '')));
      }
    }
    return output.join('\n') || '没有差异。';
  }

  /** 使用 LCS 计算行级编辑；限制教学文件大小，防止同步算法阻塞页面。 */
  function edits(base, changed) {
    const a = lines(base), b = lines(changed);
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const result = [];
    let i = 0, j = 0, current = null;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        if (current) { result.push(current); current = null; }
        i++; j++;
      } else {
        if (!current) current = { start: i, end: i, lines: [] };
        if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) current.lines.push(b[j++]);
        else { i++; current.end = i; }
      }
    }
    if (current) result.push(current);
    return result;
  }

  function conflictBlock(ours, theirs, label) {
    const terminated = text => text && !text.endsWith('\n') ? text + '\n' : text;
    return '<<<<<<< HEAD\n' + terminated(ours || '') + '=======\n' + terminated(theirs || '') + '>>>>>>> ' + label + '\n';
  }

  /** 对重叠的行级编辑组成冲突组；修改/删除单独保留三个版本供编辑器解释。 */
  function mergeText(base, ours, theirs, label) {
    if (ours === theirs) return { text: ours, conflict: false };
    if (ours === base) return { text: theirs, conflict: false };
    if (theirs === base) return { text: ours, conflict: false };
    if (ours === undefined || theirs === undefined || base === undefined) return { text: conflictBlock(ours, theirs, label), conflict: true };
    const original = lines(base);
    const changes = [...edits(base, ours).map(e => ({ ...e, side: 0 })), ...edits(base, theirs).map(e => ({ ...e, side: 1 }))]
      .sort((a, b) => a.start - b.start || a.end - b.end || a.side - b.side);
    let cursor = 0, output = '', conflict = false;
    for (let n = 0; n < changes.length;) {
      const group = [changes[n++]];
      const start = group[0].start;
      let end = group[0].end;
      // 相邻编辑没有共同上下文时也合并为一组，与 Git 的文本冲突边界一致。
      while (n < changes.length && changes[n].start <= end) {
        const next = changes[n++]; group.push(next); end = Math.max(end, next.end);
      }
      output += original.slice(cursor, start).join('');
      const renderSide = side => {
        let pos = start, text = '';
        for (const edit of group.filter(e => e.side === side)) {
          text += original.slice(pos, edit.start).join('') + edit.lines.join(''); pos = edit.end;
        }
        return text + original.slice(pos, end).join('');
      };
      const hasOurs = group.some(e => e.side === 0), hasTheirs = group.some(e => e.side === 1);
      const left = renderSide(0), right = renderSide(1);
      if (!hasOurs) output += right;
      else if (!hasTheirs || left === right) output += left;
      else { output += conflictBlock(left, right, label); conflict = true; }
      cursor = end;
    }
    return { text: output + original.slice(cursor).join(''), conflict };
  }

  function validPath(path) {
    const parts = path.split('/');
    if (!path || path.length > 120 || /[\\\x00-\x1f:*?"<>|]/.test(path) || parts.some(p => !p || ['.', '..', '.git', '__proto__', 'constructor', 'prototype'].includes(p))) {
      throw new Error('文件名须为相对路径，例如 src/hello.txt；不支持特殊设备路径、.git 或上级目录。');
    }
  }

  function validBranch(name) {
    if (!name || name.length > 60 || /^[-/.]/.test(name) || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name) || /\.\.|@\{|\/\/|\.$|\/$/.test(name) || name.split('/').some(p => p.startsWith('.') || p.endsWith('.lock') || ['__proto__', 'constructor', 'prototype'].includes(p)) || ['HEAD', '@'].includes(name)) {
      throw new Error('分支名无效，请使用 main、bugFix 或 feature/login 这样的名称。');
    }
  }

  /** 本地与协作者编辑遵守相同文本限制，换行统一后才写入各自的工作区。 */
  function normalizeFileText(text) {
    if (typeof text !== 'string' || text.includes('\0') || text.length > 20000 || lines(text).length > 300) throw new Error('教学文件仅支持普通文本，最多 300 行、20000 个字符。');
    return text.replace(/\r\n/g, '\n');
  }

  /** 协作者是独立的多分支仓库；工作区、暂存区、stash 和 HEAD 随同一套命令语义变化。 */
  class RemoteWorkspace {
    constructor(branch, commit, remote = null) {
      this.branch = branch; this.baseId = commit.id; this.base = clone(commit.tree);
      this.work = clone(commit.tree); this.index = clone(commit.tree);
      // 只在建立协作者仓库时复制远程；之后必须 fetch，不能通过查看或切分支偷取新历史。
      this.commits = clone(remote?.commits || { [commit.id]: commit }); this.tracking = clone(remote?.branches || { [branch]: commit.id });
      this.branches = { [branch]: commit.id }; this.head = { branch, id: null }; this.upstreams = { [branch]: branch };
      this.tags = {}; this.stashes = []; this.reflog = []; this.previousCheckout = null; this.pending = null;
    }
    editFile(path, text) {
      validPath(path); const normalized = normalizeFileText(text);
      if (keys(this.work, this.index).some(p => p !== path && (p.startsWith(path + '/') || path.startsWith(p + '/')))) throw new Error('文件路径与已有文件/目录冲突。');
      this.work[path] = normalized;
    }
    deleteFile(path) {
      validPath(path);
      if (!own(this.work, path)) throw new Error('协作者工作区中没有这个文件。');
      delete this.work[path];
    }
    stage(paths) {
      const targets = paths === '.' ? keys(this.base, this.index, this.work) : paths;
      if (!Array.isArray(targets) || targets.some(path => !keys(this.base, this.index, this.work).includes(path))) throw new Error('请选择存在的文件或待暂存的删除。');
      for (const path of targets) {
        put(this.index, path, value(this.work, path));
        if (this.pending) this.pending.unresolved = this.pending.unresolved.filter(item => item !== path);
      }
      if (this.pending?.type === 'stash' && !this.pending.unresolved.length) this.pending = null;
    }
    fileStatus() {
      return keys(this.base, this.index, this.work).map(path => ({ path, staged: value(this.base, path) !== value(this.index, path), unstaged: value(this.index, path) !== value(this.work, path), untracked: !own(this.base, path) && !own(this.index, path) && own(this.work, path), deleted: !own(this.work, path), conflict: Boolean(this.pending?.unresolved.includes(path)) }));
    }
    isClean() { return same(this.base, this.index) && same(this.index, this.work); }
    /** 复用同一引擎的提交、推送和整合语义，不借用“我的本地”的对象或引用。 */
    commandRepository(sim) {
      const repository = Object.create(Simulator.prototype);
      const commits = clone(this.commits), objects = { ...sim.state.remote.commits, ...commits };
      // 构造器只接收起点；补齐该起点的父链，不能悄悄导入远程后来的新提交。
      const visit = id => { if (!objects[id]) throw new Error('协作者提交历史不完整，请重新载入远程。'); commits[id] = clone(objects[id]); objects[id].parents.forEach(parent => { if (!own(commits, parent)) visit(parent); }); };
      visit(this.baseId); Object.values(this.tracking).forEach(visit);
      repository.state = {
        commits, branches: clone(this.branches),
        head: clone(this.head), index: clone(this.index), work: clone(this.work),
        tags: clone(this.tags), tracking: clone(this.tracking), upstreams: clone(this.upstreams), pending: clone(this.pending), stashes: clone(this.stashes), reflog: clone(this.reflog), previousCheckout: clone(this.previousCheckout),
        remote: clone(sim.state.remote), nextId: sim.state.nextId
      };
      return repository;
    }

    commandContext(sim) {
      const repository = this.commandRepository(sim);
      const upstream = this.upstreams[this.branch], destination = upstream || this.branch;
      const actual = sim.state.remote.branches[destination], local = repository.ancestors(this.baseId), remote = repository.ancestors(actual, sim.state.remote.commits);
      return { mode: 'remote', state: repository.state, files: repository.fileStatus(), upstream, actual,
        stale: Object.keys(sim.state.remote.branches).some(branch => this.tracking[branch] !== sim.state.remote.branches[branch]),
        ahead: [...local].filter(id => !remote.has(id)).length, behind: [...remote].filter(id => !local.has(id)).length };
    }

    /** 先在独立快照中执行；失败不改变任何一方，成功 commit 仅占用全局唯一的模拟编号。 */
    execute(sim, input) {
      const before = sim.snapshot();
      try {
        const command = Commands.parse(input);
        if (command.name === 'commit' && command.message !== null && command.message.length > 200) throw new Error('请填写提交说明，最多 200 个字符。');
        const repository = this.commandRepository(sim), result = repository.execute(input);
        if (!result.ok) return { ...result, before, after: before };
        const readOnly = ['status', 'log', 'show', 'diff', 'remote', 'reflog'].includes(command.name) || (['branch', 'tag', 'stash'].includes(command.name) && command.action === 'list');
        if (!readOnly) {
          this.baseId = repository.headId(); this.base = clone(repository.headTree());
          this.index = clone(repository.state.index); this.work = clone(repository.state.work);
          this.commits = clone(repository.state.commits); this.tracking = clone(repository.state.tracking); this.pending = clone(repository.state.pending);
          this.head = clone(repository.state.head); this.branch = this.head.branch;
          for (const key of ['branches', 'upstreams', 'tags', 'stashes', 'reflog', 'previousCheckout']) this[key] = clone(repository.state[key]);
          sim.state.nextId = repository.state.nextId;
        }
        if (command.name === 'push') sim.state.remote = clone(repository.state.remote);
        return { ...result, actor: 'remote', branch: command.name === 'push' ? command.branch || this.upstreams[this.branch] || this.branch : this.branch, commitId: command.name === 'commit' ? this.baseId : undefined,
          output: '模拟协作者 · 本地 ' + (this.branch || '分离 HEAD ' + this.baseId) + '\n' + result.output,
          explanation: command.name === 'commit' ? '协作者已提交到自己的本地仓库，尚未推送。执行 git push 后才会更新共享远程；你的本地需 fetch / pull 获取。' : '此命令操作协作者仓库。' + result.explanation,
          graphBefore: result.before, graphAfter: result.after, before, after: sim.snapshot() };
      } catch (error) {
        return { ok: false, output: error.message, explanation: '命令未执行，本地仓库、虚拟远程和协作者草稿保持不变。', before, after: before };
      }
    }
  }

  /** 所有状态均为页面内的可序列化数据；提交快照创建后不再修改。 */
  class Simulator {
    constructor(scene = 'basic') { this.loadScene(scene); }

    snapshot() { return clone(this.state); }
    headId() { return this.state.head.branch ? this.state.branches[this.state.head.branch] : this.state.head.id; }
    headTree() { return this.state.commits[this.headId()].tree; }
    isClean() { return same(this.headTree(), this.state.index) && same(this.state.index, this.state.work); }

    /** 非法命令整体回滚；合法但产生冲突的命令保留中间状态，等待用户解决。 */
    execute(input) {
      const before = this.snapshot();
      try {
        const command = Commands.parse(input);
        const pending = this.state.pending;
        const readOnly = ['status', 'log', 'diff', 'show', 'remote', 'reflog'].includes(command.name) || (['branch', 'tag'].includes(command.name) && command.action === 'list') || (command.name === 'stash' && command.action === 'list');
        const discardStashConflict = pending?.type === 'stash' && command.name === 'reset' && command.mode === 'hard';
        if (pending?.type === 'stash' && !readOnly && command.name !== 'add' && !discardStashConflict) throw new Error('stash 恢复冲突尚未解决：编辑后 git add；也可 reset --hard 丢弃恢复结果。stash 记录仍保留，没有 --continue 或 --abort。');
        if (pending && pending.type !== 'stash' && !readOnly && command.name !== 'add' && !(command.name === pending.type && ['continue', 'abort', 'skip'].includes(command.action)) && !(command.name === 'commit' && pending.type === 'merge' && !command.amend)) {
          throw new Error('当前处于 ' + this.state.pending.type + ' 处理中，请先解决并继续，或使用对应的 --abort。');
        }
        const result = this.dispatch(command);
        // reflog 只记录 HEAD 更新，查看、文件编辑、失败命令及远程变化不伪装成移动记录。
        const previousId = before.head.branch ? before.branches[before.head.branch] : before.head.id;
        const nextId = this.headId();
        if (previousId !== nextId || before.head.branch !== this.state.head.branch || ['reset', 'switch', 'checkout'].includes(command.name) && !command.paths || command.name === 'commit') {
          this.state.reflog.unshift({ id: nextId, message: input.trim() });
        }
        return { ok: true, command, before, after: this.snapshot(), ...result };
      } catch (error) {
        this.state = before;
        return { ok: false, output: error.message, explanation: '这条命令未执行，仓库状态保持不变。', before, after: this.snapshot() };
      }
    }

    dispatch(c) {
      switch (c.name) {
        case 'status': return this.status();
        case 'log': return this.log(c);
        case 'diff': return this.diff(c.cached);
        case 'show': return this.show(c.ref);
        case 'remote': return { output: c.verbose ? 'origin\t模拟远程（无真实地址） (fetch)\norigin\t模拟远程（无真实地址） (push)' : 'origin', explanation: '此网页只有虚拟 origin；真实终端的 remote -v 会显示仓库地址，这里不会连接网络。' };
        case 'reflog': return { output: this.state.reflog.map((item, n) => item.id + ' HEAD@{' + n + '}: ' + item.message).join('\n'), explanation: '这是本次页面会话的教学记录，每条改变 HEAD 的命令记录最终位置；批量摘取、变基的内部移动不逐步记录。可用 HEAD@{n} 找回位置；刷新或切换场景会清空。' };
        case 'tag': return this.tag(c);
        case 'rm': return this.remove(c);
        case 'mv': return this.renameFile(c);
        case 'restore': return this.restore(c);
        case 'stash': return this.stash(c);
        case 'add': return this.add(c.paths);
        case 'commit': return this.commit(c.message, c);
        case 'branch': return this.branch(c);
        case 'switch': case 'checkout': return this.checkout(c);
        case 'cherry-pick':
          if (c.action === 'abort') return this.abort(c.name);
          if (c.action === 'continue') return this.continueOperation(c.name);
          if (c.action === 'skip') return this.skipCherryPick();
          return this.cherryPick(c);
        case 'merge': case 'rebase': case 'revert':
          if (c.action === 'abort') return this.abort(c.name);
          if (c.action === 'continue') return this.continueOperation(c.name);
          return this[c.name](c);
        case 'reset': return this.reset(c);
        case 'fetch': return this.fetch();
        case 'pull': return this.pull(c);
        case 'push': return this.push(c);
        default: throw new Error('未实现的命令。');
      }
    }

    /** 引用查找只访问本地对象；fetch 前不能通过远程真实提交 ID 越过同步过程。 */
    resolve(ref) {
      const log = /^HEAD@\{(\d+)\}$/.exec(ref);
      if (log) {
        const entry = this.state.reflog[Number(log[1])];
        if (!entry) throw new Error('没有这个 HEAD 更新记录：' + ref);
        return entry.id;
      }
      const match = /^(.*?)([~^])(\d*)$/.exec(ref);
      if (match) {
        let id = this.resolve(match[1]);
        const count = match[3] === '' ? 1 : Number(match[3]);
        if (!Number.isSafeInteger(count) || count > 1000) throw new Error('引用层级过大。');
        if (match[2] === '^') {
          if (count === 0) return id;
          id = this.state.commits[id].parents[count - 1];
          if (!id) throw new Error('该提交不存在指定的父提交。');
        } else {
          for (let n = 0; n < count; n++) {
            id = this.state.commits[id].parents[0];
            if (!id) throw new Error('该提交不存在这么多层祖先。');
          }
        }
        return id;
      }
      if (ref === 'HEAD') return this.headId();
      if (own(this.state.branches, ref)) return this.state.branches[ref];
      if (own(this.state.tags, ref)) return this.state.tags[ref].id;
      if (ref.startsWith('origin/') && own(this.state.tracking, ref.slice(7))) return this.state.tracking[ref.slice(7)];
      if (own(this.state.commits, ref)) return ref;
      const matches = Object.values(this.state.commits).filter(c => /^[a-f\d]{4,7}$/i.test(ref) && c.hash.startsWith(ref.toLowerCase()));
      if (matches.length === 1) return matches[0].id;
      throw new Error('找不到或无法唯一确定引用：' + ref + '。可点击图中的 C 编号查看提交。');
    }

    ancestors(id, objects = this.state.commits) {
      const found = new Set(), stack = [id];
      while (stack.length) {
        const current = stack.pop();
        if (!current || found.has(current) || !own(objects, current)) continue;
        found.add(current); stack.push(...objects[current].parents);
      }
      return found;
    }

    isAncestor(a, b, objects) { return this.ancestors(b, objects).has(a); }

    mergeBase(a, b) {
      const common = [...this.ancestors(a)].filter(id => this.ancestors(b).has(id));
      const best = common.filter(id => !common.some(other => other !== id && this.isAncestor(id, other)));
      if (best.length !== 1) throw new Error('教学版暂不支持无共同祖先或存在多个最佳合并基点的复杂历史。');
      return best[0];
    }

    newCommit(tree, parents, message, remoteOnly = false) {
      const order = this.state.nextId++, id = 'C' + order;
      // 记录本次页面会话的实际创建时间，仓库浏览不以提交顺序伪造相对时间。
      const commit = { id, hash: (order + 1).toString(16).padStart(7, '0'), parents: [...parents], tree: clone(tree), message, order, timestamp: Date.now() };
      (remoteOnly ? this.state.remote.commits : this.state.commits)[id] = commit;
      return id;
    }

    moveHead(id) {
      if (this.state.head.branch) this.state.branches[this.state.head.branch] = id;
      else this.state.head.id = id;
    }

    installTree(tree) { this.state.index = clone(tree); this.state.work = clone(tree); }

    requireClean(operation) {
      if (!this.isClean()) throw new Error('本教学版执行 ' + operation + ' 前要求工作区和暂存区干净，请先 add 并 commit、stash 临时保存，或使用 reset 处理改动。这是教学版的支持边界。');
    }

    /** 编辑只影响工作区，已暂存内容始终保持 add 时的快照。 */
    editFile(path, text) {
      validPath(path);
      const normalized = normalizeFileText(text);
      if (keys(this.state.work, this.state.index).some(p => p !== path && (p.startsWith(path + '/') || path.startsWith(p + '/')))) throw new Error('文件路径与已有文件/目录冲突。');
      this.state.work[path] = normalized;
    }

    deleteFile(path) {
      validPath(path);
      if (!own(this.state.work, path)) throw new Error('工作区中没有这个文件。');
      delete this.state.work[path];
    }

    fileStatus() {
      return keys(this.headTree(), this.state.index, this.state.work).map(path => ({
        path,
        staged: value(this.headTree(), path) !== value(this.state.index, path),
        unstaged: value(this.state.index, path) !== value(this.state.work, path),
        untracked: !own(this.headTree(), path) && !own(this.state.index, path) && own(this.state.work, path),
        deleted: !own(this.state.work, path),
        conflict: Boolean(this.state.pending?.unresolved.includes(path))
      }));
    }

    status() {
      const name = this.state.head.branch || ('分离 HEAD：' + this.headId());
      const output = ['当前分支：' + name];
      const upstream = this.state.upstreams[this.state.head.branch];
      if (upstream && own(this.state.tracking, upstream)) {
        const local = this.ancestors(this.headId()), remote = this.ancestors(this.state.tracking[upstream]);
        output.push('相对 origin/' + upstream + '：领先 ' + [...local].filter(x => !remote.has(x)).length + '，落后 ' + [...remote].filter(x => !local.has(x)).length + '（基于最近同步的引用）');
      }
      if (this.state.pending) output.push('进行中：' + this.state.pending.type);
      for (const f of this.fileStatus()) {
        if (f.conflict) output.push('冲突待解决  ' + f.path);
        else {
          if (f.staged) output.push('已暂存      ' + f.path);
          if (f.untracked) output.push('未跟踪      ' + f.path);
          else if (f.unstaged) output.push((f.deleted ? '工作区删除  ' : '未暂存      ') + f.path);
        }
      }
      if (this.isClean()) output.push('工作区干净，没有待提交的更改。');
      return { output: output.join('\n'), explanation: 'status 只查看状态。工作区、暂存区和提交是三个独立的快照。' };
    }

    log(c) {
      const reachable = c.all ? new Set([...Object.values(this.state.branches), ...Object.values(this.state.tracking), ...Object.values(this.state.tags).map(tag => tag.id), this.headId()].flatMap(id => [...this.ancestors(id)])) : this.ancestors(this.headId());
      const commits = Object.values(this.state.commits).filter(x => reachable.has(x.id));
      // 按 DAG 拓扑输出，保证父提交在所有子提交之后出现，而非假设创建时间等于拓扑。
      const pending = new Set(commits.map(x => x.id)), ordered = [];
      while (pending.size) {
        const tips = commits.filter(x => pending.has(x.id) && !commits.some(child => pending.has(child.id) && child.parents.includes(x.id))).sort((a, b) => b.order - a.order);
        for (const item of tips) { ordered.push(item); pending.delete(item.id); }
      }
      return { output: ordered.map(x => (c.graph ? '* ' : '') + x.id + ' ' + x.hash + ' ' + x.message + (c.graph ? '  [父：' + (x.parents.join(', ') || '无') + ']' : '')).join('\n'), explanation: '这里只列出可达历史；C 编号和短 ID 均为模拟标识。图形画布展示完整父子连线，文本 --graph 用父提交列表表达拓扑。' };
    }

    diff(cached) {
      const a = cached ? this.headTree() : this.state.index, b = cached ? this.state.index : this.state.work;
      const output = [];
      for (const path of keys(a, b)) {
        const unresolved = this.state.pending?.unresolved.includes(path);
        if (cached && unresolved) { output.push('* 未合并路径：' + path); continue; }
        if (value(a, path) === value(b, path) || (!cached && !own(a, path) && !unresolved)) continue;
        output.push('--- ' + path + '\n+++ ' + path);
        for (const edit of edits(value(a, path), value(b, path))) {
          output.push('@@ 原文件行 ' + (edit.start + 1) + ' @@');
          output.push(...lines(value(a, path)).slice(edit.start, edit.end).map(x => '-' + x.replace(/\n$/, '')));
          output.push(...edit.lines.map(x => '+' + x.replace(/\n$/, '')));
        }
      }
      return { output: output.join('\n') || '没有差异。', explanation: cached ? 'diff --cached 比较暂存区与 HEAD：这些内容会进入下一次提交。' : 'diff 比较工作区与暂存区；与 Git 一样，未跟踪文件不出现在此差异中。' };
    }

    show(ref) {
      const commit = this.state.commits[this.resolve(ref)];
      const output = ['提交 ' + commit.id + ' (' + commit.hash + ')', '父提交：' + (commit.parents.join('、') || '无'), commit.message];
      for (const parent of commit.parents.length ? commit.parents : [null]) {
        if (commit.parents.length > 1) output.push('相对父提交 ' + parent + ' 的差异（教学展示）：');
        output.push(treeDiff(parent ? this.state.commits[parent].tree : {}, commit.tree));
      }
      return { output: output.join('\n\n'), explanation: 'show 查看提交说明和文件改动，不移动 HEAD。合并提交在教学版中分别与每个父提交比较。' };
    }

    /** staged 从 HEAD 恢复暂存区；默认从暂存区恢复工作区，不改变提交引用。 */
    restore(c) {
      const source = c.staged ? this.headTree() : this.state.index;
      const known = c.staged ? keys(source, this.state.index) : keys(source);
      const selected = c.paths.includes('.') ? known : [...new Set(c.paths)];
      for (const path of c.paths.filter(p => p !== '.')) {
        validPath(path);
        if (!known.includes(path)) throw new Error('恢复来源中没有该文件：' + path + '。restore 不删除未跟踪文件。');
      }
      const target = clone(c.staged ? this.state.index : this.state.work);
      for (const path of selected) put(target, path, value(source, path));
      checkTreePaths(target);
      if (c.staged) this.state.index = target; else this.state.work = target;
      return { output: (c.staged ? '已取消暂存：' : '已恢复工作区文件：') + selected.join('、'), explanation: c.staged ? '暂存区恢复为 HEAD，工作区修改保留；已暂存的新文件变为未跟踪。' : '工作区恢复为暂存区内容，该文件尚未暂存的修改已丢弃；已暂存内容和 HEAD 不变。' };
    }

    /** 暂存架独立保存快照，不伪装成用户提交；pop 默认恢复改动，不恢复原暂存划分。 */
    stash(c) {
      const stack = this.state.stashes;
      if (c.action === 'list') return { output: stack.map((item, n) => 'stash@{' + n + '}: On ' + item.branch + ': ' + item.message).join('\n') || '没有暂存记录。', explanation: 'stash@{0} 是最近保存的一份；pop、apply 和 drop 可以指定记录编号。' };
      if (c.action === 'clear') { this.state.stashes = []; return { output: '已清空虚拟 stash 记录。', explanation: 'clear 移除全部临时记录，工作区和提交不变。' }; }
      if (c.action === 'push') {
        const head = this.headTree(), tracked = keys(head, this.state.index), work = {}, untracked = {};
        for (const path of tracked) put(work, path, value(this.state.work, path));
        for (const path of Object.keys(this.state.work)) if (!tracked.includes(path)) untracked[path] = this.state.work[path];
        if (same(head, this.state.index) && same(head, work) && (!c.includeUntracked || !Object.keys(untracked).length)) return { output: '没有需要临时保存的改动。', explanation: '默认只保存已跟踪文件；-u 也包含未跟踪文件。' };
        stack.unshift({ base: clone(head), index: clone(this.state.index), work: clone(work), untracked: c.includeUntracked ? clone(untracked) : {}, branch: this.state.head.branch || 'detached HEAD', message: c.message ?? ('WIP ' + this.headId()) });
        const nextWork = { ...(c.includeUntracked ? {} : untracked), ...clone(head) };
        checkTreePaths(nextWork);
        this.state.index = clone(head); this.state.work = nextWork;
        return { output: '已保存到 stash@{0}：' + stack[0].message, explanation: '已跟踪的工作区和暂存区回到 HEAD；' + (c.includeUntracked ? '未跟踪文件也一起保存并移出工作区。' : '未跟踪文件留在工作区。') + ' HEAD 和分支位置不变，可切换分支后再 stash pop。' };
      }
      if (!stack.length) throw new Error('没有可恢复的 stash 记录。');
      const position = c.index || 0, item = stack[position], head = this.headTree(), label = 'stash@{' + position + '}';
      if (!item) throw new Error('没有该 stash 记录：' + label);
      if (c.action === 'drop') { stack.splice(position, 1); return { output: '已移除 ' + label, explanation: '只删除这份临时记录，工作区和提交不变。' }; }
      if (!same(head, this.state.index) || keys(head).some(p => value(head, p) !== value(this.state.work, p))) throw new Error('教学版 stash ' + c.action + ' 前要求已跟踪文件与暂存区干净，请先提交或再次 stash。未跟踪文件可保留，但不能与恢复路径重叠。');
      const loose = {};
      for (const path of Object.keys(this.state.work)) if (!own(this.state.index, path)) loose[path] = this.state.work[path];
      const restored = keys(item.work, item.untracked), present = keys(this.state.work, this.state.index);
      const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
      if (keys(loose).some(p => restored.some(q => overlaps(p, q))) || keys(item.untracked).some(p => present.some(q => overlaps(p, q)))) throw new Error('stash ' + c.action + ' 将覆盖现有文件或目录，已拒绝；stash 记录仍保留。');
      const merged = this.mergeTrees(item.base, head, item.work, label);
      checkTreePaths({ ...loose, ...merged.tree, ...item.untracked });
      const op = { type: 'stash', conflicts: merged.conflicts, unresolved: [] };
      if (Object.keys(merged.conflicts).length) {
        this.applyMerge(merged, op); this.state.pending = op;
        this.state.work = { ...loose, ...this.state.work, ...clone(item.untracked) };
        return { conflict: true, output: 'CONFLICT：' + op.unresolved.join('、') + '\n' + label + ' 已保留。', explanation: 'stash 恢复时发生冲突。编辑文件并 add，全部标记解决后即可正常提交；没有 stash --continue 或 --abort。记录继续保留。' };
      }
      this.state.work = { ...loose, ...merged.tree, ...clone(item.untracked) };
      this.state.index = clone(head);
      // 与默认 Git stash pop 一致：普通修改不自动暂存，恢复的新增文件进入暂存区。
      for (const path of keys(merged.tree)) if (!own(head, path)) this.state.index[path] = merged.tree[path];
      if (c.action === 'pop') stack.splice(position, 1);
      return { output: '已恢复' + (c.action === 'pop' ? '并移除 ' : '并保留 ') + label, explanation: '普通修改需要重新 add；新增的已跟踪文件恢复到暂存区。apply 保留记录，pop 成功后移除；冲突时均保留记录。' };
    }

    /** 默认 rm 同时删除工作区与暂存项；--cached 仅取消跟踪，并保护未保存到任一位置的暂存内容。 */
    remove(c) {
      for (const path of c.paths) {
        validPath(path);
        if (!own(this.state.index, path)) throw new Error('文件未被跟踪：' + path);
        const staged = value(this.state.index, path), head = value(this.headTree(), path), work = value(this.state.work, path);
        if (c.cached ? staged !== head && staged !== work : staged !== head || work !== undefined && work !== staged) throw new Error('删除可能丢失未提交内容，请先检查、提交或 restore：' + path);
      }
      for (const path of c.paths) { delete this.state.index[path]; if (!c.cached) delete this.state.work[path]; }
      return { output: '已' + (c.cached ? '取消跟踪：' : '删除并暂存：') + c.paths.join('、'), explanation: c.cached ? '文件仍在工作区；删除跟踪记录已进入暂存区，需要提交。' : '删除已进入暂存区，需要 commit 才会写入历史。仅支持明确的文件路径。' };
    }

    /** 只移动普通文件；保留来源的暂存快照，未暂存编辑跟随文件移动。 */
    renameFile(c) {
      validPath(c.source); validPath(c.destination);
      if (!own(this.state.index, c.source) || !own(this.state.work, c.source)) throw new Error('来源必须是工作区中存在的已跟踪文件。');
      if (keys(this.state.work, this.state.index).some(p => p !== c.source && (p === c.destination || p.startsWith(c.destination + '/') || c.destination.startsWith(p + '/'))) || c.source === c.destination) throw new Error('目标路径已存在或与其他文件冲突。');
      this.state.index[c.destination] = this.state.index[c.source]; this.state.work[c.destination] = this.state.work[c.source];
      delete this.state.index[c.source]; delete this.state.work[c.source];
      return { output: c.source + ' → ' + c.destination, explanation: '移动已暂存为旧路径删除和新路径增加；原来未暂存的编辑仍未暂存。教学版不进行重命名检测。' };
    }

    /** 标签固定指向提交；注解只存为教学元数据，不模拟独立 tag 对象与签名。 */
    tag(c) {
      if (c.action === 'list') return { output: Object.keys(this.state.tags).sort().join('\n') || '没有本地标签。', explanation: 'tag 标记版本，不会跟随分支提交自动移动。' };
      validBranch(c.tag);
      if (c.action === 'delete') {
        if (!own(this.state.tags, c.tag)) throw new Error('标签不存在。');
        delete this.state.tags[c.tag]; return { output: '已删除本地标签 ' + c.tag, explanation: '只移除本地标签，不删除提交，也不修改虚拟远程。' };
      }
      if (own(this.state.tags, c.tag)) throw new Error('标签已经存在，未覆盖。');
      const id = this.resolve(c.ref); this.state.tags[c.tag] = { id, message: c.message ?? null };
      return { output: c.tag + ' → ' + id, explanation: '本地标签已指向此提交，可用于 show、checkout 等引用；教学版不提供标签推送、签名或独立 tag 对象。' };
    }

    add(paths) {
      const all = keys(this.state.index, this.state.work, this.headTree());
      const selected = paths.includes('.') ? all : [...new Set(paths)];
      for (const path of paths.filter(path => path !== '.')) { validPath(path); if (!all.includes(path)) throw new Error('找不到文件：' + path); }
      for (const path of selected) { validPath(path); if (!all.includes(path)) throw new Error('找不到文件：' + path); }
      for (const path of selected) {
        put(this.state.index, path, value(this.state.work, path));
        if (this.state.pending) this.state.pending.unresolved = this.state.pending.unresolved.filter(p => p !== path);
      }
      if (this.state.pending?.type === 'stash' && !this.state.pending.unresolved.length) this.state.pending = null;
      return { output: '已暂存：' + (selected.join('、') || '没有改动'), explanation: 'add 将此刻的工作区内容复制到暂存区。之后继续编辑文件，不会自动更新已经暂存的内容。冲突文件 add 后视为已解决，请自行检查是否仍留有冲突标记。' };
    }

    commit(message, options = {}) {
      const operation = this.state.pending;
      if (options.amend && operation) throw new Error('操作处理中不能 amend，请先继续或中止。');
      if (options.all) {
        if (operation) throw new Error('冲突中请显式 git add 解决文件，再提交。');
        // 已 rm --cached 的路径属于未跟踪文件，不能因 HEAD 曾有它而被 -a 重新加入。
        for (const path of Object.keys(this.state.index)) put(this.state.index, path, value(this.state.work, path));
      }
      if (operation?.unresolved.length) throw new Error('还有未解决的冲突，请编辑文件并 git add。');
      if (!operation && !options.amend && same(this.headTree(), this.state.index)) throw new Error('没有已暂存的改动，无法创建空提交。请先编辑文件并 git add。');
      const old = this.state.commits[this.headId()]; message = message ?? old.message;
      const parents = options.amend ? old.parents : operation ? [this.headId(), operation.other] : [this.headId()];
      const id = this.newCommit(this.state.index, parents, message);
      this.moveHead(id); this.state.pending = null;
      return { output: '[' + (this.state.head.branch || 'detached HEAD') + ' ' + id + '] ' + message, explanation: options.amend ? '用新提交替换当前提交的位置，保留原父提交；旧提交仍可通过 reflog 找到。已发布的共享提交应先与团队确认再修改。' : operation ? '冲突解决完成，创建包含两个父提交的合并提交。' : 'commit 保存暂存区快照，并把当前分支和 HEAD 向前移动；尚未暂存的编辑仍留在工作区。' };
    }

    branch(c) {
      if (c.action === 'list') {
        const output = Object.keys(this.state.branches).map(name => {
          const id = this.state.branches[name], upstream = this.state.upstreams[name], remote = this.state.tracking[upstream];
          let relation = '';
          if (upstream) {
            const localHistory = this.ancestors(id), remoteHistory = remote ? this.ancestors(remote) : new Set();
            relation = remote ? ' [origin/' + upstream + '：领先 ' + [...localHistory].filter(x => !remoteHistory.has(x)).length + '，落后 ' + [...remoteHistory].filter(x => !localHistory.has(x)).length + ']' : ' [origin/' + upstream + '：已丢失]';
          }
          return (name === this.state.head.branch ? '* ' : '  ') + name + ' → ' + id + (c.verbose ? relation + ' ' + this.state.commits[id].message : '');
        });
        if (c.all) for (const [name, id] of Object.entries(this.state.tracking)) output.push('  remotes/origin/' + name + ' → ' + id + (c.verbose ? ' ' + this.state.commits[id].message : ''));
        return { output: output.join('\n'), explanation: '-a 同时列出本地分支与本地远程跟踪引用；-vv 显示上游和领先/落后数量，依据最近一次同步。创建分支不会自动切换。' };
      }
      if (c.action === 'rename') {
        const from = c.branch || this.state.head.branch; validBranch(c.target);
        if (!from || !own(this.state.branches, from)) throw new Error('找不到要改名的本地分支。');
        if (from === c.target) return { output: '分支名称未变化。', explanation: '分支仍指向原提交。' };
        if (own(this.state.branches, c.target)) throw new Error('目标分支名称已经存在。');
        this.state.branches[c.target] = this.state.branches[from]; delete this.state.branches[from];
        if (own(this.state.upstreams, from)) { this.state.upstreams[c.target] = this.state.upstreams[from]; delete this.state.upstreams[from]; }
        if (this.state.head.branch === from) this.state.head.branch = c.target;
        return { output: from + ' → ' + c.target, explanation: '只更改本地分支名称，提交与文件不变；原有上游配置保留，远程分支不会改名。' };
      }
      validBranch(c.branch);
      if (c.action === 'create') {
        if (own(this.state.branches, c.branch)) throw new Error('分支已经存在：' + c.branch);
        this.state.branches[c.branch] = this.resolve(c.ref || 'HEAD');
        return { output: '已创建分支 ' + c.branch, explanation: '新分支指向 ' + (c.ref || 'HEAD') + ' 对应的提交，HEAD 仍停在原位置。' };
      }
      if (!own(this.state.branches, c.branch)) throw new Error('分支不存在。');
      if (c.branch === this.state.head.branch) throw new Error('不能删除当前所在分支，请先切换到其他分支。');
      const upstream = this.state.upstreams[c.branch];
      const target = upstream && this.state.tracking[upstream] ? this.state.tracking[upstream] : this.headId();
      if (!this.isAncestor(this.state.branches[c.branch], target)) throw new Error('分支尚未完全合入目标，-d 拒绝删除。请先合并。');
      delete this.state.branches[c.branch]; delete this.state.upstreams[c.branch];
      return { output: '已删除分支标签 ' + c.branch, explanation: '删除分支标签不等于立即删除提交对象，旧节点仍可在图中查看。' };
    }

    /** 允许带着不受切换影响的改动跨分支移动；会覆盖本地改动时拒绝整个操作。 */
    checkout(c) {
      if (c.paths) {
        if (!c.ref) return this.restore({ paths: c.paths });
        const source = this.state.commits[this.resolve(c.ref)].tree;
        const selected = c.paths.includes('.') ? Object.keys(source) : [...new Set(c.paths)];
        for (const path of c.paths.filter(p => p !== '.')) { validPath(path); if (!own(source, path)) throw new Error('指定提交中没有该文件：' + path); }
        const index = clone(this.state.index), work = clone(this.state.work);
        for (const path of selected) index[path] = work[path] = source[path];
        checkTreePaths(index); checkTreePaths(work); this.state.index = index; this.state.work = work;
        return { output: '已从 ' + c.ref + ' 恢复：' + selected.join('、'), explanation: 'checkout <提交> -- <文件> 同时恢复暂存区和工作区，不切换 HEAD；checkout -- <文件> 只从暂存区恢复工作区。' };
      }
      const previous = clone(this.state.head);
      if (c.ref === '-') {
        if (!this.state.previousCheckout) throw new Error('本次练习还没有上一次分支切换记录。');
        c = { ...c, ref: this.state.previousCheckout.branch || this.state.previousCheckout.id, detach: !this.state.previousCheckout.branch };
      }
      if (c.create) {
        validBranch(c.ref);
        if (own(this.state.branches, c.ref)) throw new Error('分支已经存在。');
        this.state.branches[c.ref] = this.headId(); this.state.head = { branch: c.ref, id: null };
      } else {
        // 与单一 origin 的常见 Git 配置一致：已有同名跟踪引用时可创建并切换本地分支。
        if (!c.detach && !own(this.state.branches, c.ref) && own(this.state.tracking, c.ref)) {
          this.state.branches[c.ref] = this.state.tracking[c.ref]; this.state.upstreams[c.ref] = c.ref;
        }
        const id = this.resolve(c.ref), isBranch = !c.detach && own(this.state.branches, c.ref);
        if (c.name === 'switch' && !isBranch && !c.detach) throw new Error('switch 需要本地分支名；查看提交请用 switch --detach 或 checkout。');
        const old = this.headTree(), target = this.state.commits[id].tree;
        const nextIndex = clone(this.state.index), nextWork = clone(this.state.work);
        for (const path of keys(old, target, this.state.index, this.state.work)) {
          const from = value(old, path), to = value(target, path), staged = value(this.state.index, path), work = value(this.state.work, path);
          if (from === to) continue;
          if (from === undefined && staged === undefined && work !== undefined) throw new Error('切换将覆盖未跟踪文件：' + path);
          if ((staged !== from || work !== staged) && !(staged === to && work === staged) && !(staged === from && work === to)) throw new Error('切换将覆盖本地改动：' + path + '。请先提交或处理改动。');
          put(nextIndex, path, to); put(nextWork, path, to);
        }
        for (const path of keys(nextWork)) {
          if (keys(target).some(p => p !== path && (p.startsWith(path + '/') || path.startsWith(p + '/')))) throw new Error('切换将覆盖本地文件/目录：' + path);
        }
        this.state.head = { branch: isBranch ? c.ref : null, id: isBranch ? null : id };
        this.state.index = nextIndex; this.state.work = nextWork;
      }
      this.state.previousCheckout = previous;
      return { output: '已切换到 ' + (this.state.head.branch || ('分离 HEAD ' + this.headId())), explanation: this.state.head.branch ? 'HEAD 现在跟随这个分支；后续提交只会移动当前分支。' : 'HEAD 直接指向提交，处于分离状态。可用 switch -c 新建分支来保存后续提交。' };
    }

    mergeTrees(base, ours, theirs, label) {
      const tree = {}, conflicts = {};
      for (const path of keys(base, ours, theirs)) {
        const result = mergeText(value(base, path), value(ours, path), value(theirs, path), label);
        put(tree, path, result.text);
        if (result.conflict) conflicts[path] = { base: value(base, path) ?? null, ours: value(ours, path) ?? null, theirs: value(theirs, path) ?? null };
      }
      const paths = Object.keys(tree);
      if (paths.some(p => paths.some(other => other.startsWith(p + '/')))) throw new Error('教学版暂不支持文件与目录之间的合并冲突。');
      return { tree, conflicts };
    }

    applyMerge(result, operation) {
      this.state.work = clone(result.tree); this.state.index = clone(result.tree);
      operation.conflicts = result.conflicts; operation.unresolved = Object.keys(result.conflicts);
      for (const path of operation.unresolved) put(this.state.index, path, result.conflicts[path].ours ?? undefined);
    }

    merge(c) {
      this.requireClean('merge');
      const target = this.resolve(c.ref), current = this.headId();
      if (this.isAncestor(target, current)) return { output: 'Already up to date.', explanation: '目标历史已经包含在当前分支中，不需要新提交。' };
      if (!c.noFF && this.isAncestor(current, target)) {
        this.moveHead(target); this.installTree(this.headTree());
        return { output: 'Fast-forward：' + current + ' → ' + target, explanation: '当前提交是目标的祖先，只移动分支标签，不创建额外合并提交。' };
      }
      const saved = this.snapshot(), base = this.mergeBase(current, target);
      const result = this.mergeTrees(this.state.commits[base].tree, this.headTree(), this.state.commits[target].tree, c.ref);
      const operation = { type: 'merge', saved, other: target, message: "Merge branch '" + c.ref + "'", unresolved: [], conflicts: {} };
      this.applyMerge(result, operation);
      if (operation.unresolved.length) { this.state.pending = operation; return this.conflictResult(); }
      const id = this.newCommit(this.state.index, [current, target], operation.message);
      this.moveHead(id);
      return { output: '合并成功，创建 ' + id, explanation: '两条历史通过一个包含两个父提交的新节点汇合，原来的提交保留。' };
    }

    rebase(c) {
      this.requireClean('rebase');
      if (!this.state.head.branch) throw new Error('教学版仅支持对当前本地分支执行 rebase，请先 switch 到分支。');
      const onto = this.resolve(c.ref), current = this.headId();
      if (this.isAncestor(onto, current)) return { output: '当前分支已基于该目标，无需变基。', explanation: '目标已经是当前分支的祖先。' };
      this.mergeBase(current, onto);
      const targetHistory = this.ancestors(onto);
      const queue = [...this.ancestors(current)].filter(id => !targetHistory.has(id)).sort((a, b) => this.state.commits[a].order - this.state.commits[b].order);
      if (queue.some(id => this.state.commits[id].parents.length > 1)) throw new Error('教学版暂不支持重放合并提交，请选择普通线性分支练习 rebase。');
      const saved = this.snapshot(), branch = this.state.head.branch;
      this.state.pending = { type: 'rebase', saved, branch, queue, cursor: 0, unresolved: [], conflicts: {}, rewritten: [] };
      this.state.head = { branch: null, id: onto }; this.installTree(this.headTree());
      return this.advanceRebase();
    }

    /** 冲突暂停时分支标签仍在原位置，临时分离 HEAD 指向已重放的最后一个提交。 */
    advanceRebase() {
      const op = this.state.pending;
      while (op.cursor < op.queue.length) {
        const original = this.state.commits[op.queue[op.cursor]];
        const base = original.parents.length ? this.state.commits[original.parents[0]].tree : {};
        const result = this.mergeTrees(base, this.headTree(), original.tree, original.id + ' ' + original.message);
        this.applyMerge(result, op);
        if (op.unresolved.length) return this.conflictResult();
        if (!same(this.headTree(), result.tree)) {
          const id = this.newCommit(result.tree, [this.headId()], original.message);
          op.rewritten.push([original.id, id]); this.moveHead(id);
        }
        op.cursor++;
      }
      const id = this.headId(); this.state.branches[op.branch] = id; this.state.head = { branch: op.branch, id: null };
      const rewrites = op.rewritten.map(pair => pair.join(' → ')).join('，');
      this.state.pending = null;
      return { output: '变基完成。' + (rewrites || '仅快进分支。'), explanation: '按原顺序把提交改动重放到新基点上。新提交有新的 ID，原提交对象仍保留；已经存在的空改动会跳过。' };
    }

    revert(c) {
      this.requireClean('revert');
      const id = this.resolve(c.ref), target = this.state.commits[id];
      if (target.parents.length > 1) throw new Error('教学版仅支持撤回普通提交，不支持需要 -m 主线选择的合并提交。');
      const parent = target.parents.length ? this.state.commits[target.parents[0]].tree : {};
      const saved = this.snapshot(), result = this.mergeTrees(target.tree, this.headTree(), parent, '撤回 ' + id);
      if (same(this.headTree(), result.tree) && !Object.keys(result.conflicts).length) throw new Error('该提交的反向改动为空，未创建提交。');
      const op = { type: 'revert', saved, target: id, message: 'Revert "' + target.message + '"', unresolved: [], conflicts: {} };
      this.applyMerge(result, op);
      if (op.unresolved.length) { this.state.pending = op; return this.conflictResult(); }
      const next = this.newCommit(this.state.index, [this.headId()], op.message); this.moveHead(next);
      return { output: '已创建反向提交 ' + next, explanation: 'revert 添加一个抵消指定改动的新提交，保留原来的历史和分支前进方向。' };
    }

    /** 摘取的是提交相对父提交的改动；不合并来源分支的全部历史，也不直接复制整份快照。 */
    cherryPick(c) {
      this.requireClean('cherry-pick');
      const queue = c.refs.map(ref => this.resolve(ref));
      if (queue.some(id => this.state.commits[id].parents.length > 1)) throw new Error('教学版 cherry-pick 仅支持普通提交，不支持需要 -m 指定主线的合并提交。');
      this.state.pending = { type: 'cherry-pick', saved: this.snapshot(), queue, cursor: 0, unresolved: [], conflicts: {}, rewritten: [] };
      return this.advanceCherryPick();
    }

    advanceCherryPick() {
      const op = this.state.pending;
      while (op.cursor < op.queue.length) {
        const original = this.state.commits[op.queue[op.cursor]], base = original.parents.length ? this.state.commits[original.parents[0]].tree : {};
        const result = this.mergeTrees(base, this.headTree(), original.tree, original.id + ' ' + original.message);
        this.applyMerge(result, op);
        if (op.unresolved.length) return this.conflictResult();
        if (same(this.headTree(), this.state.index)) return { paused: true, output: '当前摘取改动为空：' + original.id + '。使用 git cherry-pick --skip 跳过，或 --abort 恢复起点。', explanation: '这份改动可能已经存在，或原提交为空；与 Git 默认行为一样暂停，不伪造新提交。' };
        const id = this.newCommit(this.state.index, [this.headId()], original.message);
        this.moveHead(id); op.rewritten.push([original.id, id]); op.cursor++;
      }
      const changes = op.rewritten.map(pair => pair.join(' → ')).join('，'); this.state.pending = null;
      return { output: '摘取完成。' + (changes || '全部已跳过。'), explanation: '仅把指定提交的改动逐个应用到当前分支，每次生成一个普通提交；来源分支和原提交保持不变。' };
    }

    skipCherryPick() {
      const op = this.state.pending;
      if (!op || op.type !== 'cherry-pick') throw new Error('没有进行中的 cherry-pick 操作。');
      this.installTree(this.headTree()); op.cursor++; op.unresolved = []; op.conflicts = {};
      return this.advanceCherryPick();
    }

    continueOperation(type) {
      const op = this.state.pending;
      if (!op || op.type !== type) throw new Error('没有进行中的 ' + type + ' 操作。');
      if (op.unresolved.length) throw new Error('请先解决所有冲突，并 git add 对应文件。');
      if (type === 'merge') return this.commit(op.message);
      if (!same(this.state.work, this.state.index)) throw new Error('工作区与暂存区仍有差异，请先检查并暂存解决结果。');
      if (type === 'cherry-pick') {
        if (same(this.headTree(), this.state.index)) throw new Error('解决结果没有新的改动，请使用 cherry-pick --skip 跳过或 --abort 中止。');
        const original = this.state.commits[op.queue[op.cursor]], id = this.newCommit(this.state.index, [this.headId()], original.message);
        this.moveHead(id); op.rewritten.push([original.id, id]); op.cursor++;
        return this.advanceCherryPick();
      }
      if (type === 'rebase') {
        const original = this.state.commits[op.queue[op.cursor]];
        if (!same(this.headTree(), this.state.index)) {
          const id = this.newCommit(this.state.index, [this.headId()], original.message);
          op.rewritten.push([original.id, id]); this.moveHead(id);
        }
        op.cursor++; return this.advanceRebase();
      }
      if (same(this.headTree(), this.state.index)) throw new Error('反向改动为空，请使用 revert --abort。');
      const id = this.newCommit(this.state.index, [this.headId()], op.message); this.moveHead(id); this.state.pending = null;
      return { output: '撤回完成，创建 ' + id, explanation: '已把暂存的冲突解决结果保存为新的反向提交。' };
    }

    /** 中止恢复原来的引用与文件；已生成对象和独立远程更新仍保留，符合历史对象不可变约束。 */
    abort(type) {
      const op = this.state.pending;
      if (!op || op.type !== type) throw new Error('没有进行中的 ' + type + ' 操作。');
      const { commits, nextId, remote, reflog } = this.state;
      this.state = clone(op.saved); this.state.commits = commits; this.state.nextId = nextId; this.state.remote = remote; this.state.reflog = reflog;
      return { output: '已中止 ' + type, explanation: 'HEAD、分支标签、工作区和暂存区恢复到本次操作前。' };
    }

    conflictResult() {
      const op = this.state.pending;
      return { conflict: true, output: 'CONFLICT：' + op.unresolved.join('、'), explanation: '操作暂停。编辑冲突文件，检查并删除冲突标记，git add 后执行 git ' + op.type + ' --continue；也可用 --abort 恢复。' };
    }

    reset(c) {
      const id = this.resolve(c.ref), target = this.state.commits[id].tree;
      if (c.mode === 'hard') {
        const untracked = {};
        for (const path of Object.keys(this.state.work)) {
          if (!own(this.state.index, path) && !own(this.headTree(), path) && !keys(target).some(p => p === path || p.startsWith(path + '/') || path.startsWith(p + '/'))) untracked[path] = this.state.work[path];
        }
        this.state.index = clone(target); this.state.work = { ...untracked, ...clone(target) };
      } else if (c.mode === 'mixed') this.state.index = clone(target);
      this.moveHead(id);
      if (this.state.pending?.type === 'stash') this.state.pending = null;
      const meanings = { soft: '只移动分支/HEAD，暂存区和工作区保持原样。', mixed: '移动分支/HEAD，并让暂存区回到目标快照；工作区保持原样。', hard: '移动分支/HEAD，同时重置暂存区和已跟踪文件。无冲突的未跟踪文件保留。' };
      return { output: 'HEAD → ' + id + '（--' + c.mode + '）', explanation: meanings[c.mode] + ' 图中旧提交淡化显示，便于比较。' };
    }

    fetch() {
      for (const id of Object.keys(this.state.remote.commits)) this.state.commits[id] = clone(this.state.remote.commits[id]);
      this.state.tracking = clone(this.state.remote.branches);
      return { output: Object.entries(this.state.tracking).map(([name, id]) => 'origin/' + name + ' → ' + id).join('\n'), explanation: 'fetch 下载远程提交并更新本地的 origin/* 引用，不移动当前分支，也不改工作区。' };
    }

    pull(c) {
      this.requireClean('pull');
      if (!this.state.head.branch) throw new Error('请先切换到本地分支再 pull。');
      const branch = c.branch || this.state.upstreams[this.state.head.branch];
      if (!branch || !own(this.state.remote.branches, branch)) throw new Error('没有有效的上游分支，请明确输入 git pull origin main。');
      this.fetch();
      const result = c.rebase ? this.rebase({ ref: 'origin/' + branch }) : this.merge({ ref: 'origin/' + branch });
      return { ...result, explanation: 'pull 已先执行 fetch，再执行 ' + (c.rebase ? 'rebase' : 'merge（本练习默认配置）') + '。' + result.explanation };
    }

    push(c) {
      const source = c.branch || this.state.head.branch;
      if (!source || !own(this.state.branches, source)) throw new Error('找不到要推送的本地分支。');
      const destination = c.branch || this.state.upstreams[source];
      if (!destination) throw new Error('当前分支没有上游，请使用 git push -u origin ' + source + '。');
      const id = this.state.branches[source], old = this.state.remote.branches[destination];
      const objects = { ...this.state.remote.commits, ...this.state.commits };
      if (old && !this.isAncestor(old, id, objects)) throw new Error('推送被拒绝（non-fast-forward）：远程有本地尚未整合的历史。请先 fetch/pull 并整合，再 push。');
      for (const current of this.ancestors(id)) this.state.remote.commits[current] = clone(this.state.commits[current]);
      this.state.remote.branches[destination] = id; this.state.tracking[destination] = id;
      if (c.setUpstream) this.state.upstreams[source] = destination;
      return { output: source + ' → origin/' + destination + '：' + id, explanation: 'push 上传提交并移动远程分支，同时更新本地对应的远程跟踪引用。它不会自动合并远程分叉。' };
    }

    /** 协作者直接在远程创建提交；全部输入先校验，草稿过期时拒绝覆盖新的远程历史。 */
    commitRemote(branch, draft) {
      try {
        if (typeof branch !== 'string' || !own(this.state.remote.branches, branch)) throw new Error('请选择一个已存在的远程分支；本地新分支需先 push。');
        const old = this.state.remote.branches[branch];
        if (!draft || draft.baseId !== old) throw new Error('远程分支已更新，请重新载入远程文件后再编辑和提交。');
        if (typeof draft.message !== 'string' || !draft.message.trim() || draft.message.length > 200) throw new Error('请填写提交说明，最多 200 个字符。');
        if (!draft.tree || typeof draft.tree !== 'object' || Array.isArray(draft.tree) || ![Object.prototype, null].includes(Object.getPrototypeOf(draft.tree))) throw new Error('文件快照格式无效。');
        const tree = {};
        for (const [path, text] of Object.entries(draft.tree)) { validPath(path); tree[path] = normalizeFileText(text); }
        checkTreePaths(tree);
        const previous = this.state.remote.commits[old].tree;
        if (same(previous, tree)) throw new Error('暂存区没有可提交的变化，请先编辑并暂存文件。');
        const message = draft.message.trim(), id = this.newCommit(tree, [old], message, true);
        this.state.remote.branches[branch] = id;
        return { ok: true, commitId: id, branch, output: '虚拟远程 ' + branch + ' 新增 ' + id + '\n提交说明：' + message + '\n本次文件变更：\n' + treeDiff(previous, tree), explanation: '协作者已提交到远程 ' + branch + '。你的本地分支、文件、暂存区和 origin/' + branch + ' 尚未变化；fetch 下载更新，pull 再整合到本地。' };
      } catch (error) { return { ok: false, output: error.message, explanation: '远程提交未创建，仓库与协作者草稿保持不变。' }; }
    }

    /** 场景预置和快捷示例自动追加一行；协作者自由编辑通过独立仓库 commit 后再 push。 */
    simulateRemote(branch) {
      if (branch === undefined) branch = own(this.state.remote.branches, 'main') ? 'main' : Object.keys(this.state.remote.branches)[0];
      // 不把本地分支或跟踪引用误当作远程实际分支，校验失败时不创建对象或消耗提交编号。
      if (typeof branch !== 'string' || !own(this.state.remote.branches, branch)) {
        return { ok: false, output: '请选择一个已存在的远程分支。', explanation: '本地新分支需要先执行 git push -u origin <分支名>，才能在远程模拟他人提交。' };
      }
      const old = this.state.remote.branches[branch], previous = this.state.remote.commits[old].tree, tree = clone(previous);
      const path = 'team.txt', added = '协作者更新 ' + this.state.nextId;
      const content = own(tree, path) ? tree[path] : '团队协作记录\n';
      // 在远程快照末尾追加独立一行，不读取或保存本地工作区及编辑草稿。
      tree[path] = content + (content && !content.endsWith('\n') ? '\n' : '') + added + '\n';
      const message = '协作者：在 team.txt 追加“' + added + '”';
      const id = this.newCommit(tree, [old], message, true); this.state.remote.branches[branch] = id;
      return {
        ok: true, commitId: id, branch,
        output: '虚拟远程 ' + branch + ' 新增 ' + id + '\n提交说明：' + message + '\n本次文件变更：\n' + treeDiff(previous, tree),
        explanation: '协作者已在远程 ' + branch + ' 的 team.txt 追加一行“' + added + '”。本地 origin/' + branch + '、工作区和暂存区尚未变化；fetch 下载提交，pull 才整合到本地文件。'
      };
    }

    /** 六个场景均从同一个小型文本仓库派生，场景预置不伪装成用户执行的命令。 */
    loadScene(scene) {
      if (!own(SCENES, scene)) throw new Error('未知练习场景。');
      this.scene = scene;
      this.state = { commits: {}, branches: {}, tags: {}, head: { branch: 'main', id: null }, index: {}, work: {}, stashes: [], reflog: [], previousCheckout: null, pending: null, remote: { commits: {}, branches: {} }, tracking: {}, upstreams: { main: 'main' }, nextId: 0 };
      const tree = { 'hello.txt': '你好，Git！\n这是一段问候。\n保留这一行作为共同上下文。\n学习从一次提交开始。\n', 'README.md': '# Git Playground\n\n在这里安心练习 Git。\n' };
      const first = this.newCommit(tree, [], '初始化练习仓库');
      this.state.branches.main = first; this.installTree(tree);
      this.state.remote = { commits: clone(this.state.commits), branches: { main: first } }; this.state.tracking.main = first;
      const save = (message, edit) => {
        const next = clone(this.headTree()); edit(next);
        const id = this.newCommit(next, [this.headId()], message); this.moveHead(id); this.installTree(next); return id;
      };
      if (scene === 'basic') {
        save('补充 README 中的提交练习步骤', t => { t['README.md'] += '\n## 提交练习\n\n编辑 hello.txt，保存后执行 git add hello.txt，再执行 git commit。\n'; });
        save('补充 README 中的远程同步说明', t => { t['README.md'] += '\n## 远程同步\n\nfetch 更新远程跟踪记录，pull 整合到当前分支，push 上传本地提交。\n'; });
        // 基础场景预置完整历史并同步虚拟远程，避免起点就出现待推送提交或误算练习进度。
        const tip = this.headId();
        this.state.remote = { commits: clone(this.state.commits), branches: { main: tip } };
        this.state.tracking.main = tip;
      } else if (['branches', 'conflict', 'rebase'].includes(scene)) {
        save('准备分支练习', t => { t['notes.txt'] = '学习分支与 HEAD\n'; });
        this.state.branches.bugFix = this.headId();
        this.state.head.branch = 'bugFix';
        save('修复问候语', t => { t['hello.txt'] = t['hello.txt'].replace('你好，Git！', '你好，修复后的 Git！'); });
        this.state.head.branch = 'main'; this.installTree(this.headTree());
        save('主分支继续开发', t => {
          if (scene === 'conflict') t['hello.txt'] = t['hello.txt'].replace('你好，Git！', '欢迎，主分支！');
          else t['README.md'] += '\n主分支新增使用说明。\n';
        });
        if (scene === 'rebase') { this.state.head.branch = 'bugFix'; this.installTree(this.headTree()); }
      } else if (scene === 'reset') {
        save('增加第二版问候', t => { t['hello.txt'] += '第二版内容\n'; });
        save('增加第三版问候', t => { t['hello.txt'] += '第三版内容\n'; });
      } else if (scene === 'remote') {
        save('本地：新增学习记录', t => { t['notes.txt'] = '这是本地的提交。\n'; });
        this.simulateRemote();
      }
      this.state.reflog = [{ id: this.headId(), message: '练习场景起点' }];
    }
  }

  const SCENES = {
    basic: { title: '基础提交', subtitle: '让一次改动，成为一个提交。', hint: 'main 已预置 3 次提交。先编辑 hello.txt 并保存，再依次执行 add 和 commit，观察新节点。', commands: ['git status', 'git add hello.txt', 'git commit -m "第一次修改"', 'git log --oneline'] },
    branches: { title: '分支与合并', subtitle: '两个分支，如何汇成一条历史？', hint: 'main 和 bugFix 已经分叉，合并它们，观察双亲提交。', commands: ['git branch', 'git merge bugFix', 'git switch bugFix', 'git switch main'] },
    conflict: { title: '合并冲突', subtitle: '同一行有两种答案，由你决定。', hint: '执行 merge 后，编辑 hello.txt 的冲突标记，add 并继续。', commands: ['git merge bugFix', 'git add hello.txt', 'git merge --continue', 'git merge --abort'] },
    rebase: { title: '变基练习', subtitle: '把你的改动，搬到新的起点。', hint: '当前位于 bugFix。把它变基到 main，观察旧、新提交的区别。', commands: ['git rebase main', 'git log --oneline --graph --all', 'git rebase --continue', 'git rebase --abort'] },
    reset: { title: 'Reset 对比', subtitle: '同样退一步，三个区域各不相同。', hint: '已有三次提交。分别重置场景，试试 soft、mixed、hard。', commands: ['git reset --soft HEAD~1', 'git reset --mixed HEAD~1', 'git reset --hard HEAD~1', 'git revert HEAD'] },
    remote: { title: '远程协作', subtitle: '看清本地、远程与中间的那条线。', hint: '本地和远程各有一个新提交。先 push 看拒绝原因，再 fetch、pull、push。', commands: ['git push', 'git fetch', 'git pull --no-rebase origin main', 'git push'] }
  };
  const api = { Simulator, RemoteWorkspace, SCENES, mergeText, edits, same };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitSimulator = api;
})(globalThis);
