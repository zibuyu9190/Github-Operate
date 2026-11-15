/* 补全和推荐只生成输入文本，不执行命令；同一数据逻辑可在 Node 中验证。 */
(function (root) {
  'use strict';
  const catalog = {
    status: ['查看仓库与文件状态', 'status'],
    log: ['查看提交历史', 'log [--oneline] [--graph] [--all]'],
    diff: ['查看文件差异', 'diff [--cached]'],
    show: ['查看提交说明和文件改动', 'show [引用]'],
    restore: ['取消暂存或丢弃未暂存修改', 'restore [--staged] <文件…> | restore [--staged] .'],
    stash: ['临时保存与恢复改动', 'stash push [-u] [-m "说明"] | stash list | stash (pop|apply|drop) [stash@{n}] | stash clear'],
    remote: ['查看虚拟远程仓库', 'remote [-v]'],
    add: ['暂存文件的当前内容', 'add <文件…> | add .'],
    commit: ['保存提交或修订最近一次提交', 'commit [-a] -m "说明" | commit --amend (-m "说明" | --no-edit)'],
    branch: ['列出、创建、改名或删除分支', 'branch [-a] [-vv] | branch <名称> [引用] | branch -m [旧名] <新名> | branch -d <名称>'],
    switch: ['专门切换或创建分支', 'switch <分支> | switch -c <新分支> | switch - | switch --detach <引用>'],
    checkout: ['切换分支、查看提交或恢复文件', 'checkout <引用> | checkout -b <新分支> | checkout [引用] -- <文件>'],
    'cherry-pick': ['把指定提交的改动摘取到当前分支', 'cherry-pick <提交…> | cherry-pick (--continue | --abort | --skip)'],
    reflog: ['查看本页面的 HEAD 更新记录', 'reflog [--oneline]；用 HEAD@{n} 找回历史位置'],
    tag: ['列出、创建或删除本地版本标签', 'tag [名称 [引用]] | tag -a <名称> [引用] -m "说明" | tag -d <名称>'],
    rm: ['删除跟踪文件并暂存，或仅取消跟踪', 'rm [--cached] <文件…>'],
    mv: ['移动或改名普通文件', 'mv <来源文件> <目标文件>'],
    merge: ['合并另一条历史', 'merge [--no-ff] <引用> | merge --continue | merge --abort'],
    rebase: ['把提交重放到新基点', 'rebase <引用> | rebase --continue | rebase --abort'],
    reset: ['调整 HEAD、暂存区或工作区', 'reset [--soft | --mixed | --hard] [引用]'],
    revert: ['用新提交撤回一次改动', 'revert <普通提交> | revert --continue | revert --abort'],
    fetch: ['下载虚拟远程的最新历史', 'fetch [origin]'],
    pull: ['下载并整合远程历史', 'pull [--rebase | --no-rebase] [origin [分支]]'],
    push: ['推送本地提交到虚拟远程', 'push [origin [分支]] | push -u origin <分支>']
  };
  const quote = text => /^[^\s"'\\;&|`<>]+$/.test(text) ? text : '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const headId = state => state.head.branch ? state.branches[state.head.branch] : state.head.id;
  const ancestor = (state, base, tip) => {
    const seen = new Set(), queue = [tip];
    while (queue.length) {
      const id = queue.pop();
      if (!id || seen.has(id)) continue;
      if (id === base) return true;
      seen.add(id); queue.push(...(state.commits[id]?.parents || []));
    }
    return false;
  };

  /** 容忍尚未闭合的引号，并保留每个词的范围；补全光标所在词时不覆盖后面的参数。 */
  function tokens(input) {
    const result = [];
    let start = -1, value = '', quoted = '';
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (start < 0 && /\s/.test(ch)) continue;
      if (start < 0) start = i;
      if (quoted) {
        if (ch === quoted) quoted = '';
        else if (ch === '\\' && quoted === '"' && ['"', '\\'].includes(input[i + 1])) value += input[++i];
        else value += ch;
      } else if (ch === '"' || ch === "'") quoted = ch;
      else if (/\s/.test(ch)) { result.push({ start, end: i, value }); start = -1; value = ''; }
      else if (/[;&|`<>]/.test(ch)) return null;
      else value += ch;
    }
    if (start >= 0) result.push({ start, end: input.length, value });
    return result;
  }

  function contextAt(input, caret) {
    const words = tokens(input);
    if (!words) return null;
    const active = words.find(t => t.start <= caret && t.end >= caret) || { start: caret, end: caret, value: '' };
    const partial = tokens(input.slice(active.start, caret));
    const prefix = partial?.[0]?.value || '';
    const before = words.filter(t => t.end <= active.start).map(t => t.value);
    if (before[0] === 'git') before.shift();
    return { active, prefix, before, words };
  }

  /** 所有候选来自教学版支持范围；引用仅来自本地对象和本地远程跟踪引用。 */
  function complete(input, caret, context, force = false) {
    if (input.length > 2000 || (!input.trim() && !force)) return [];
    const at = contextAt(input, Math.max(0, Math.min(input.length, caret)));
    if (!at) return [];
    const { active, prefix, before } = at, state = context.state;
    const remote = context.mode === 'remote', supported = ['status', 'log', 'show', 'diff', 'add', 'restore', 'commit'];
    if (remote && before.length && !supported.includes(before[0])) return [];
    if (remote && before[0] === 'commit' && before.includes('--amend')) return [];
    let choices = [];
    const offer = (text, description, kind = '参数', edit = null) => choices.push({ text, description, kind, edit });
    const refs = (branchesOnly = false) => {
      for (const name of Object.keys(state.branches)) offer(name, remote ? '协作者远程分支' : name === state.head.branch ? '当前本地分支' : '本地分支', '分支');
      if (branchesOnly) return;
      for (const name of Object.keys(state.tracking)) offer('origin/' + name, '本地远程跟踪引用', '引用');
      for (const name of Object.keys(state.tags || {})) offer(name, '本地版本标签', '标签');
      (state.reflog || []).slice(0, 10).forEach((item, n) => offer('HEAD@{' + n + '}', item.message, '更新记录'));
      offer('HEAD', '当前提交', '引用');
      let id = headId(state);
      for (let n = 1; n <= 9; n++) {
        id = state.commits[id]?.parents[0]; if (!id) break;
        offer('HEAD~' + n, '沿第一父链向前 ' + n + ' 次', '引用');
        if (n === 1) offer('HEAD^', '当前提交的第一个父提交', '引用');
      }
      if (state.commits[headId(state)]?.parents[1]) offer('HEAD^2', '合并提交的第二个父提交', '引用');
      for (const commit of Object.values(state.commits).sort((a, b) => b.order - a.order)) {
        if (['revert', 'cherry-pick'].includes(before[0]) && commit.parents.length > 1) continue;
        offer(commit.id, commit.message, '提交');
        if (prefix && /^[0-9a-f]/.test(prefix)) offer(commit.hash, commit.message, '提交');
      }
    };
    const newBranch = () => {
      let name = 'feature', n = 2;
      while (Object.hasOwn(state.branches, name)) name = 'feature-' + n++;
      offer(name, '可修改为你想创建的分支名', '新分支');
    };
    if (!before.length) {
      if (prefix && 'git'.startsWith(prefix)) offer('git', '添加 Git 命令前缀', '命令');
      for (const [name, [description]] of Object.entries(catalog)) if (!remote || supported.includes(name)) offer(name, description, '命令');
    } else {
      const [name, ...args] = before, positional = args.filter(x => !x.startsWith('-'));
      const options = (items) => { for (const [flag, description] of items) if (!args.includes(flag)) offer(flag, description); };
      switch (name) {
        case 'log': options([['--oneline', '每个提交显示一行'], ['--graph', '显示父子拓扑'], ['--all', '显示所有本地引用可达的历史']]); break;
        case 'diff': if (!args.length) offer('--cached', '比较暂存区与 HEAD'); break;
        case 'show': if (!args.length) refs(); break;
        case 'remote': if (!args.length) offer('-v', '查看模拟远程的获取与推送信息'); break;
        case 'restore': {
          if (state.pending) break;
          if (!args.length) offer('--staged', '取消暂存，保留工作区修改');
          if (args.some(x => x.startsWith('-') && x !== '--staged')) break;
          const staged = args[0] === '--staged';
          offer('.', staged ? '取消全部暂存，保留工作区修改' : '丢弃所有已跟踪文件的未暂存修改', '文件');
          for (const file of context.files) {
            const known = Object.hasOwn(state.index, file.path) || (staged && Object.hasOwn(state.commits[headId(state)].tree, file.path));
            if (known && !args.includes(file.path)) offer(file.path, staged ? '取消该文件暂存，保留修改' : '恢复为暂存区内容，丢弃未暂存修改', '文件');
          }
          break;
        }
        case 'stash':
          if (!args.length) {
            if (!state.pending) { offer('push', '临时保存改动'); if (state.stashes.length) { offer('pop', '恢复并移除记录，冲突时保留'); offer('apply', '恢复并保留记录'); offer('drop', '移除指定记录'); offer('clear', '移除所有虚拟 stash 记录'); } }
            offer('list', '列出暂存记录');
          } else if (['pop', 'apply', 'drop'].includes(args[0]) && args.length === 1 && !state.pending) {
            state.stashes.forEach((item, n) => offer('stash@{' + n + '}', item.message, '暂存记录'));
          } else if (args[0] === 'push' && !state.pending) {
            if (args.at(-1) === '-m') { if (!prefix) offer('', '在引号内填写暂存说明', '说明', 'message'); }
            else {
              options([['-u', '包含未跟踪文件'], ['-m', '指定暂存说明']]);
            }
          }
          break;
        case 'add': {
          offer('.', '暂存所有新增、修改和删除', '文件');
          const paths = [...context.files].sort((a, b) => Number(b.unstaged || b.conflict) - Number(a.unstaged || a.conflict));
          for (const file of paths) if (!args.includes(file.path)) offer(file.path, file.conflict ? '冲突文件：检查内容后暂存' : file.unstaged ? '有待暂存的改动' : '已跟踪文件', '文件');
          break;
        }
        case 'commit':
          if (args.at(-1) === '-m' || args.at(-1) === '-am') { if (!prefix) offer('', '在引号内填写提交说明', '说明', 'message'); }
          else { if (!args.includes('-m') && !args.includes('--no-edit') && !args.includes('-am')) offer('-m', '填写提交说明'); if (!args.includes('-a') && !args.includes('-am')) offer('-a', '自动暂存已跟踪文件，不包含未跟踪文件'); if (!remote) { if (!args.includes('--amend')) offer('--amend', '用新提交替换最近提交的位置'); else if (!args.includes('-m')) offer('--no-edit', '沿用原提交说明'); } }
          break;
        case 'branch':
          if (!args.length) { offer('-d', '仅删除已合入的非当前分支'); offer('-m', '修改本地分支名称'); options([['-a', '列出本地与远程跟踪分支'], ['-vv', '查看上游与领先/落后关系']]); newBranch(); }
          else if (args.length === 1 && args[0] === '-d') {
            for (const name of Object.keys(state.branches)) if (name !== state.head.branch) offer(name, '待删除的本地分支，请确认已合入', '分支');
          }
          else if (args.every(x => ['-a', '-vv'].includes(x))) options([['-a', '列出本地与远程跟踪分支'], ['-vv', '查看上游与领先/落后关系']]);
          else if (args[0] === '-m') { if (args.length === 1) refs(true); newBranch(); }
          else if (args.length === 1 && !args[0].startsWith('-')) refs();
          break;
        case 'switch': case 'checkout':
          if (name === 'checkout' && args.includes('--')) {
            if (!args.includes('.')) offer('.', '恢复全部来源文件，不切换分支', '文件');
            for (const file of context.files) if (!args.includes(file.path) && (args.indexOf('--') !== 0 || Object.hasOwn(state.index, file.path))) offer(file.path, '恢复文件内容，不切换分支', '文件');
          } else if (!args.length) { offer(name === 'switch' ? '-c' : '-b', '创建并切换到新分支'); offer('--detach', '查看指定提交，进入分离 HEAD'); if (state.previousCheckout) offer('-', '回到上一次切换的位置'); if (name === 'checkout') offer('--', '恢复文件，不切换分支'); refs(name === 'switch'); }
          else if (args.length === 1 && args[0] === (name === 'switch' ? '-c' : '-b')) newBranch();
          else if (args[0] === '--detach' && args.length === 1) refs();
          break;
        case 'merge': case 'rebase': case 'revert': case 'cherry-pick':
          if (!args.length && state.pending?.type === name) {
            if (!state.pending.unresolved.length && (name !== 'cherry-pick' || context.files.some(f => f.staged))) offer('--continue', '已暂存解决结果后继续');
            offer('--abort', '中止操作并恢复开始前的状态');
            if (name === 'cherry-pick') offer('--skip', '丢弃当前摘取结果并继续后续提交');
          } else if (!state.pending && !positional.length && !args.some(x => x !== '--no-ff')) {
            if (name === 'merge' && !args.length) offer('--no-ff', '需要合并时创建双亲提交');
            refs();
          }
          else if (name === 'cherry-pick' && !state.pending && args.every(x => !x.startsWith('-'))) refs();
          break;
        case 'rm': case 'mv':
          if (name === 'rm' && !args.length) offer('--cached', '只取消跟踪，保留工作区文件');
          if (name === 'rm' || args.length === 0) for (const file of context.files) if (Object.hasOwn(state.index, file.path) && !args.includes(file.path)) offer(file.path, '已跟踪文件', '文件');
          break;
        case 'tag':
          if (!args.length) { offer('-l', '列出标签'); offer('-d', '删除本地标签'); offer('-a', '创建带说明的本地标签'); offer('v1.0', '可编辑版本号', '新标签'); }
          else if (args[0] === '-d') for (const name of Object.keys(state.tags || {})) offer(name, '待删除的本地标签', '标签');
          else if (args.at(-1) === '-m' && !prefix) offer('', '填写标签说明', '说明', 'message');
          else if (args[0] === '-a') { if (args.length === 1) offer('v1.0', '可编辑版本号', '新标签'); else if (!args.includes('-m')) { offer('-m', '填写标签说明'); refs(); } }
          else if (args.length === 1 && !args[0].startsWith('-')) refs();
          break;
        case 'reset':
          if (!args.some(x => x.startsWith('-'))) options([['--soft', '仅移动 HEAD，保留暂存区和工作区'], ['--mixed', '移动 HEAD 并重置暂存区，保留工作区'], ['--hard', '同时覆盖已跟踪的工作区改动，请谨慎']]);
          if (!positional.length) refs();
          break;
        case 'fetch': if (!args.length) offer('origin', '虚拟远程仓库', '远程'); break;
        case 'pull': case 'push':
          if (!args.some(x => x.startsWith('-'))) options(name === 'pull' ? [['--rebase', '下载后使用变基整合'], ['--no-rebase', '下载后使用合并整合']] : [['-u', '推送并设置上游，需要 origin 和分支']]);
          if (!positional.length) offer('origin', '虚拟远程仓库', '远程');
          else if (positional.length === 1 && positional[0] === 'origin') for (const branch of Object.keys(name === 'push' ? state.branches : state.remote.branches)) offer(branch, name === 'push' ? '要推送的本地分支' : '要拉取的远程分支', '分支');
          break;
      }
    }
    const seen = new Set();
    return choices.filter(c => (c.edit || (c.text.startsWith(prefix) && c.text !== active.value)) && !seen.has(c.text) && seen.add(c.text)).slice(0, 12).map(c => {
      const text = c.edit === 'message' ? '""' : quote(c.text);
      const suffix = input.slice(active.end), space = !c.edit && !suffix ? ' ' : '';
      const value = input.slice(0, active.start) + text + space + suffix;
      const cursor = active.start + text.length + space.length - (c.edit ? 1 : 0);
      return { label: c.edit ? '"说明"' : c.text, description: c.description, kind: c.kind, value, start: cursor, end: cursor };
    });
  }

  function usage(input, context = {}) {
    const parts = tokens(input.trim());
    if (!parts) return '一次输入一条 Git 命令';
    const name = parts[0]?.value === 'git' ? parts[1]?.value : parts[0]?.value;
    if (context.mode === 'remote') {
      if (name === 'commit') return '协作者用法：git commit [-a] -m "说明" · 直接提交到虚拟远程';
      if (!['status', 'log', 'show', 'diff', 'add', 'restore'].includes(name)) return '协作者支持 status / log / show / diff / add / restore / commit；commit 直接提交到虚拟远程';
    }
    return Object.hasOwn(catalog, name) ? '用法：git ' + catalog[name][1] : '输入命令、参数或文件名，按 Tab 自动补全';
  }

  /** 推荐随快照变化，只建议下一步；有冲突标记时不催促用户暂存或继续。 */
  function recommend(context) {
    const { state, files, scene } = context, result = [];
    const add = (command, description) => { if (!result.some(x => x.command === command)) result.push({ command, description }); };
    const changed = files.filter(f => f.unstaged || f.conflict), staged = files.some(f => f.staged);
    if (context.mode === 'remote') {
      if (context.stale) add('git status', '远程已更新，先检查草稿，再点击“重新载入远程”');
      else {
        if (changed.length) add('git add ' + (changed.length <= 2 ? changed.map(f => quote(f.path)).join(' ') : '.'), '暂存协作者的文件改动');
        if (staged) add('git commit -m "说明本次修改"', '将协作者暂存内容直接提交到所选虚拟远程分支');
      }
      if (staged) add('git diff --cached', '检查协作者准备提交的内容');
      else if (changed.some(f => !f.untracked)) add('git diff', '检查协作者尚未暂存的改动');
      add('git status', '查看协作者的工作区和暂存区');
      add('git log --oneline', '查看所选远程分支的提交历史');
      return result.slice(0, 4);
    }
    const op = state.pending, current = headId(state);
    if (op) {
      const hasMarkers = path => /^(<<<<<<< |=======|>>>>>>> )/m.test(state.work[path] || '');
      const remainingMarkers = Object.keys(op.conflicts).some(hasMarkers);
      const ready = changed.filter(f => !hasMarkers(f.path));
      if (ready.length) add('git add ' + ready.map(f => quote(f.path)).join(' '), '检查解决结果后，将这些文件标记为已解决');
      if (op.type !== 'stash' && !op.unresolved.length && !changed.length && !remainingMarkers && (op.type !== 'cherry-pick' || staged)) add('git ' + op.type + ' --continue', '解决结果已暂存，继续完成本次操作');
      if (op.type === 'cherry-pick') add('git cherry-pick --skip', '若当前改动为空或不需要此提交，跳过当前摘取');
      add('git status', remainingMarkers || op.unresolved.length ? '先在文件区解决冲突，再暂存解决结果' : '核对解决状态与暂存内容');
      if (op.type === 'stash') add('git stash list', '恢复发生冲突，原 stash 记录仍保留；解决后 add 即可');
      else add('git ' + op.type + ' --abort', '放弃本次操作，恢复开始前的仓库状态');
    } else if (changed.length || staged) {
      if (changed.length) add('git add ' + (changed.length <= 2 ? changed.map(f => quote(f.path)).join(' ') : '.'), '将工作区的改动放入暂存区');
      if (staged) {
        add('git commit -m "说明本次修改"', '暂存区已有改动，填写说明后创建提交');
        add('git diff --cached', '提交前检查暂存区相对 HEAD 的差异');
      } else if (changed.some(f => !f.untracked)) add('git diff', '检查已跟踪文件相对暂存区的差异');
      if (changed.length) add('git stash push -u -m "临时保存"', '暂时不提交时，保存改动后可切换分支');
      else if (staged) add('git restore --staged ' + quote(files.find(f => f.staged).path), '取消该文件暂存，保留工作区修改');
      add('git status', '确认哪些改动已暂存、哪些仍在工作区');
    } else {
      const upstream = state.upstreams[state.head.branch], remote = state.tracking[upstream];
      if (Object.keys(state.remote.branches).some(name => state.remote.branches[name] !== state.tracking[name])) add('git fetch origin', '远程有新变化，先更新本地 origin/* 引用');
      if (remote && !ancestor(state, remote, current)) add('git pull --no-rebase origin ' + quote(upstream), '本地缺少远程历史，下载后合并');
      if (['branches', 'conflict'].includes(scene) && state.branches.bugFix && !ancestor(state, state.branches.bugFix, current)) add('git merge bugFix', '把 bugFix 的改动合并到当前分支');
      if (scene === 'rebase' && state.head.branch !== 'main' && !ancestor(state, state.branches.main, current)) add('git rebase main', '把当前分支的提交重放到 main 之上');
      if (scene === 'reset' && state.commits[current]?.parents.length) add('git reset --soft HEAD~1', '只移动分支指针，观察改动保留在暂存区');
      if (remote && state.remote.branches[upstream] === remote && current !== remote && ancestor(state, remote, current)) add('git push', '本地有尚未推送的提交，同步到上游');
      else if (state.head.branch && !upstream) add('git push -u origin ' + quote(state.head.branch), '发布当前分支并设置上游');
      if (state.stashes.length) add('git stash pop', '恢复最近一份临时改动；冲突时记录会保留');
      add('git log --oneline --graph --all', '观察提交历史与分支指向');
      add('git status', '查看当前分支、文件和同步状态');
      if (scene === 'basic') add('git switch -c feature', '工作区干净，可以创建分支继续练习');
    }
    return result.slice(0, 4);
  }

  /** 组合框仅填入候选；只有用户提交表单才会执行命令。无候选时方向键交还历史浏览。 */
  class Controller {
    constructor(input, getContext) {
      this.input = input; this.getContext = getContext; this.items = []; this.active = -1; this.composing = false;
      const make = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text) el.textContent = text; return el; };
      this.list = make('div', 'command-completions'); this.list.id = 'command-completions'; this.list.hidden = true; this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', 'Git 命令补全候选');
      this.hint = make('div', 'command-assist-hint'); this.hint.id = 'command-assist-hint';
      this.live = make('span', 'sr-only'); this.live.setAttribute('role', 'status'); this.live.setAttribute('aria-live', 'polite');
      input.form.append(this.list, this.hint, this.live);
      input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', this.list.id); input.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-describedby', this.hint.id);
      input.addEventListener('input', () => { if (!this.composing) this.refresh(); });
      input.addEventListener('click', () => this.refresh());
      input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) this.refresh(); });
      input.addEventListener('focus', () => this.refresh());
      input.addEventListener('blur', () => this.close());
      input.addEventListener('compositionstart', () => { this.composing = true; this.close(); });
      input.addEventListener('compositionend', () => { this.composing = false; this.refresh(); });
      input.addEventListener('keydown', event => this.keydown(event));
      this.refresh(false);
    }

    refresh(show = true, force = false) {
      this.close(); this.hint.textContent = usage(this.input.value, this.getContext());
      if (!show || this.composing) return;
      this.items = complete(this.input.value, this.input.selectionStart ?? this.input.value.length, this.getContext(), force);
      if (!this.items.length) return;
      this.list.replaceChildren();
      this.items.forEach((item, i) => {
        const row = document.createElement('div'); row.className = 'completion-option'; row.id = 'command-option-' + i; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
        const code = document.createElement('code'); code.textContent = item.label;
        const kind = document.createElement('span'); kind.className = 'completion-kind'; kind.textContent = item.kind;
        const detail = document.createElement('small'); detail.textContent = item.description;
        row.append(code, kind, detail); row.addEventListener('mousedown', event => event.preventDefault()); row.addEventListener('click', () => this.accept(i)); this.list.append(row);
      });
      const tip = document.createElement('div'); tip.className = 'completion-tip'; tip.textContent = 'Tab 补全 · ↑ ↓ 选择 · Enter 确认所选 · Esc 关闭'; this.list.append(tip);
      this.list.hidden = false; this.input.setAttribute('aria-expanded', 'true'); this.live.textContent = this.items.length + ' 个补全候选，可按 Tab 补全或方向键选择';
    }

    close() {
      this.items = []; this.active = -1; this.list.hidden = true; this.input.setAttribute('aria-expanded', 'false'); this.input.removeAttribute('aria-activedescendant'); this.live.textContent = '';
    }

    accept(index) {
      const item = this.items[index]; if (!item) return;
      this.input.value = item.value; this.input.focus(); this.input.setSelectionRange(item.start, item.end); this.refresh(false);
    }

    keydown(event) {
      if (this.composing || event.isComposing || event.keyCode === 229) return;
      if (event.ctrlKey && event.code === 'Space') { event.preventDefault(); this.refresh(true, true); return; }
      if (event.key === 'Escape' && this.items.length) { event.preventDefault(); this.close(); return; }
      if (event.key === 'Tab' && !event.shiftKey && this.items.length) { event.preventDefault(); this.accept(this.active < 0 ? 0 : this.active); return; }
      if (event.key === 'Enter' && this.active >= 0) { event.preventDefault(); this.accept(this.active); return; }
      if (['ArrowUp', 'ArrowDown'].includes(event.key) && this.items.length) {
        event.preventDefault();
        this.active = this.active < 0 ? (event.key === 'ArrowDown' ? 0 : this.items.length - 1) : (this.active + (event.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
        [...this.list.querySelectorAll('[role="option"]')].forEach((row, i) => row.setAttribute('aria-selected', String(i === this.active)));
        const row = this.list.children[this.active]; this.input.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  const api = { complete, recommend, usage, Controller };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitCommandAssist = api;
})(globalThis);
