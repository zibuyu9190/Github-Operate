const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Simulator, RemoteWorkspace } = require('../simulator.js');
const { latestPathCommit } = require('../graph-viewer.js').RepositoryBrowser;

// 所有真实 Git 操作仅限仓库 target/ 下的独立临时目录，不访问真实远程或开发仓库。
const outputRoot = path.resolve(__dirname, '../../target/webui-validation');
fs.mkdirSync(outputRoot, { recursive: true });
const emptyHooks = path.join(outputRoot, 'empty-hooks');
fs.mkdirSync(emptyHooks, { recursive: true });

function fixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(outputRoot, 'git-'));
  const directory = path.join(fixtureRoot, 'work');
  fs.mkdirSync(directory);
  t.after(() => {
    const resolved = path.resolve(fixtureRoot);
    if (!resolved.startsWith(outputRoot + path.sep)) throw new Error('拒绝清理测试目录以外的路径。');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const git = (args, allowedFailure = false, cwd = directory) => {
    const result = spawnSync('git', ['-c', 'user.name=Git Playground Test', '-c', 'user.email=playground@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.editor=true', '-c', 'core.hooksPath=' + emptyHooks, ...args], {
      // 环境变量优先于 core.editor；测试沿用已有说明，不能被宿主的失败或交互式编辑器阻断。
      cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    });
    if (!allowedFailure) assert.equal(result.status, 0, args.join(' ') + '\n' + result.stderr + result.stdout);
    return result;
  };
  const sim = new Simulator();
  git(['init', '-b', 'main']);
  const edit = (file, text) => { sim.editFile(file, text); fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), text, 'utf8'); };
  // 按场景的真实起点重建全部预置提交，文件快照与父链都参与后续对照。
  let initialFiles = [];
  for (const commit of Object.values(sim.state.commits).sort((a, b) => a.order - b.order)) {
    for (const file of initialFiles) if (!Object.hasOwn(commit.tree, file)) fs.unlinkSync(path.join(directory, file));
    for (const [file, text] of Object.entries(commit.tree)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), text, 'utf8');
    }
    git(['add', '.']); git(['commit', '-m', commit.message]); initialFiles = Object.keys(commit.tree);
  }
  const command = (...args) => {
    const encoded = ['git', ...args.map(x => /\s/.test(x) ? '"' + x.replaceAll('"', '\\"') + '"' : x)].join(' ');
    const result = sim.execute(encoded), actual = git(args, true);
    assert.equal(result.ok && !result.conflict && !result.paused, actual.status === 0, encoded + '\n模拟：' + result.output + '\n实际：' + actual.stderr + actual.stdout);
    return result;
  };
  const remove = file => { sim.deleteFile(file); fs.unlinkSync(path.join(directory, file)); };
  const treeAt = ref => {
    const names = git(['ls-tree', '-rz', '--name-only', ref]).stdout.split('\0').filter(Boolean);
    return Object.fromEntries(names.map(file => [file, git(['show', ref + ':' + file]).stdout]));
  };
  const canonicalTree = tree => Object.fromEntries(Object.keys(tree).sort().map(file => [file, tree[file]]));
  const assertState = () => {
    assert.deepEqual(canonicalTree(sim.headTree()), canonicalTree(treeAt('HEAD')));
    const tracked = git(['ls-files', '-z']).stdout.split('\0').filter(Boolean);
    const index = Object.fromEntries(tracked.map(file => [file, git(['show', ':' + file]).stdout]));
    assert.deepEqual(canonicalTree(sim.state.index), canonicalTree(index));
    const work = {};
    const scan = relative => {
      for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
        if (item.name === '.git' || item.name === 'remote.git' || item.name === 'collaborator') continue;
        const file = (relative ? relative + '/' : '') + item.name;
        if (item.isDirectory()) scan(file); else work[file] = fs.readFileSync(path.join(directory, file), 'utf8');
      }
    };
    scan(''); assert.deepEqual(canonicalTree(sim.state.work), canonicalTree(work));
    const actualBranch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
    assert.equal(sim.state.head.branch, actualBranch.status === 0 ? actualBranch.stdout.trim() : null);
    // 以文件快照和有序父边递归比较拓扑，不依赖真实提交哈希或提交时间。
    const gitCache = new Map(), simCache = new Map();
    const actualShape = id => {
      if (!gitCache.has(id)) {
        const parents = git(['rev-list', '--parents', '-n', '1', id]).stdout.trim().split(' ').slice(1);
        gitCache.set(id, { tree: canonicalTree(treeAt(id)), parents: parents.map(actualShape) });
      }
      return gitCache.get(id);
    };
    const simulatedShape = id => {
      if (!simCache.has(id)) { const c = sim.state.commits[id]; simCache.set(id, { tree: canonicalTree(c.tree), parents: c.parents.map(simulatedShape) }); }
      return simCache.get(id);
    };
    for (const [branch, id] of Object.entries(sim.state.branches)) assert.deepEqual(simulatedShape(id), actualShape(git(['rev-parse', branch]).stdout.trim()), '分支拓扑：' + branch);
  };
  const commit = message => { command('add', '.'); command('commit', '-m', message); };
  return { directory, sim, git, edit, remove, command, commit, assertState };
}

test('真实 Git 对照：逐文件及目录的最近提交在分叉、合并、删除与重建后保持准确', t => {
  const f = fixture(t);
  const check = paths => {
    for (const [file, directory = false] of paths) {
      const commit = latestPathCommit(f.sim.state.commits, f.sim.headId(), file, directory);
      assert.equal(commit.message, f.git(['log', '-1', '--format=%s', 'HEAD', '--', file]).stdout.trim(), '最近提交：' + file);
    }
  };
  f.command('branch', 'feature');
  f.edit('src/local.txt', '本地文件\n'); f.commit('新增本地文件');
  check([['src', true], ['src/local.txt'], ['hello.txt']]);
  f.command('switch', 'feature'); f.edit('src/remote.txt', '分支文件\n'); f.commit('新增分支文件');
  f.command('switch', 'main'); f.command('merge', 'feature');
  check([['src', true], ['src/local.txt'], ['src/remote.txt'], ['hello.txt']]);
  f.remove('src/local.txt'); f.commit('删除本地文件'); check([['src', true], ['src/remote.txt']]);
  f.edit('src/local.txt', '重新创建\n'); f.commit('重新创建文件'); check([['src', true], ['src/local.txt']]);
  f.assertState();
});

test('真实 Git 对照：restore 的暂存/工作区恢复、新增文件取消暂存和删除恢复', t => {
  const f = fixture(t);
  f.edit('hello.txt', '暂存版\n'); f.command('add', 'hello.txt'); f.edit('hello.txt', '工作版\n');
  f.command('restore', 'hello.txt'); f.assertState();
  f.edit('hello.txt', '最新工作版\n'); f.command('restore', '--staged', 'hello.txt'); f.assertState();
  f.edit('new file.txt', '新文件\n'); f.command('add', 'new file.txt'); f.command('restore', '--staged', 'new file.txt'); f.assertState();
  f.remove('hello.txt'); f.command('restore', 'hello.txt'); f.assertState();
  f.remove('hello.txt'); f.command('add', 'hello.txt'); f.command('restore', '--staged', '.'); f.command('restore', '.'); f.assertState();
});

test('真实 Git 对照：stash 默认与 -u、暂存后再次编辑、多份保存与默认 pop', t => {
  const f = fixture(t);
  f.edit('hello.txt', '暂存版\n'); f.command('add', 'hello.txt'); f.edit('hello.txt', '工作版\n'); f.edit('untracked.txt', '保留\n');
  f.command('stash', 'push', '-m', '第一次'); f.assertState();
  f.edit('README.md', '另一份\n'); f.command('stash', 'push', '-u', '-m', '第二次'); f.assertState();
  assert.equal(f.sim.state.stashes.length, f.git(['stash', 'list']).stdout.trim().split('\n').length);
  f.command('stash', 'pop'); f.assertState(); f.command('restore', 'README.md'); f.command('stash', 'pop'); f.assertState();
  assert.equal(f.git(['stash', 'list']).stdout, '');
});

test('真实 Git 对照：stash 已暂存新文件、已暂存删除与未暂存删除', t => {
  for (const stagedDelete of [false, true]) {
    const f = fixture(t); f.edit('new.txt', '新增\n'); f.command('add', 'new.txt'); f.remove('hello.txt');
    if (stagedDelete) f.command('add', 'hello.txt');
    f.command('stash', 'push'); f.assertState(); f.command('stash', 'pop'); f.assertState();
  }
});

test('真实 Git 对照：stash 跨分支非重叠合并与冲突保留记录，add 后可普通提交', t => {
  for (const conflict of [false, true]) {
    const f = fixture(t); f.command('branch', 'feature'); f.edit('hello.txt', 'stash 内容\n'); f.command('stash', 'push', '-m', '跨分支');
    f.command('switch', 'feature'); f.edit(conflict ? 'hello.txt' : 'feature.txt', 'feature 内容\n'); f.commit('分支修改');
    const result = f.command('stash', 'pop');
    if (conflict) {
      assert.equal(result.conflict, true); assert.equal(f.sim.state.stashes.length, 1); assert.match(f.git(['stash', 'list']).stdout, /跨分支/);
      assert.ok(f.git(['ls-files', '-u']).stdout); f.edit('hello.txt', '解决结果\n'); f.command('add', 'hello.txt'); f.assertState();
      f.command('commit', '-m', '解决恢复冲突');
    }
    f.assertState();
  }
});

test('真实 Git 对照：stash pop 拒绝覆盖同名未跟踪文件，保留 stash 与文件', t => {
  const f = fixture(t); f.edit('loose.txt', '保存内容\n'); f.command('stash', 'push', '-u'); f.edit('loose.txt', '新内容\n');
  const before = f.sim.snapshot(); f.command('stash', 'pop'); f.assertState();
  assert.deepEqual(f.sim.snapshot(), before); assert.ok(f.git(['stash', 'list']).stdout);
});

test('真实 Git 对照：暂存后再修改、三种 reset 及未跟踪文件保留', t => {
  for (const mode of ['soft', 'mixed', 'hard']) {
    const f = fixture(t);
    f.edit('hello.txt', '第二版\n'); f.commit('第二版'); f.edit('hello.txt', '暂存版本\n'); f.command('add', 'hello.txt'); f.edit('hello.txt', '工作区版本\n'); f.edit('keep.txt', '未跟踪\n');
    f.command('reset', '--' + mode, 'HEAD~1'); f.assertState();
  }
});

test('真实 Git 对照：分支、带改动切换、快进与双亲合并', t => {
  for (const mode of ['ff', 'no-ff', 'diverged']) {
    const f = fixture(t); f.command('switch', '-c', 'feature'); f.edit('feature.txt', 'feature\n'); f.commit('分支提交'); f.command('switch', 'main');
    if (mode === 'diverged') { f.edit('main.txt', 'main\n'); f.commit('主分支提交'); }
    f.command('merge', ...(mode === 'no-ff' ? ['--no-ff'] : []), 'feature'); f.assertState();
    f.edit('untracked.txt', '可携带\n'); f.command('switch', 'feature'); f.assertState();
  }
});

test('真实 Git 对照：同文件非重叠改动、冲突继续与中止、修改/删除', t => {
  for (const mode of ['disjoint', 'resolve', 'abort', 'delete']) {
    const f = fixture(t), original = 'one\ntwo\nthree\nfour\nfive\nsix\n';
    f.edit('hello.txt', original); f.commit('共同基点'); f.command('branch', 'feature');
    if (mode === 'delete') f.remove('hello.txt'); else f.edit('hello.txt', original.replace('one', 'MAIN'));
    f.commit('主分支修改'); f.command('switch', 'feature');
    f.edit('hello.txt', original.replace(mode === 'disjoint' ? 'six' : 'one', 'FEATURE')); f.commit('分支修改');
    const result = f.command('merge', 'main');
    if (mode !== 'disjoint') {
      assert.equal(result.conflict, true);
      if (mode === 'abort') f.command('merge', '--abort');
      else {
        if (mode === 'delete') f.remove('hello.txt'); else f.edit('hello.txt', '双方认可的结果\n');
        f.command('add', '.'); f.command('merge', '--continue');
      }
    }
    f.assertState();
  }
});

test('真实 Git 对照：多提交变基、变基冲突继续和中止', t => {
  for (const mode of ['linear', 'resolve', 'abort']) {
    const f = fixture(t); f.command('branch', 'feature'); f.edit('hello.txt', '主分支修改\n'); f.commit('主分支修改'); f.command('switch', 'feature');
    if (mode === 'linear') f.edit('feature.txt', 'feature\n'); else f.edit('hello.txt', '分支修改\n');
    f.commit('分支提交一'); f.edit('second.txt', '第二次提交\n'); f.commit('分支提交二');
    const result = f.command('rebase', 'main');
    if (mode !== 'linear') {
      assert.equal(result.conflict, true);
      if (mode === 'abort') f.command('rebase', '--abort');
      else { f.edit('hello.txt', '变基解决结果\n'); f.command('add', '.'); f.command('rebase', '--continue'); }
    }
    f.assertState();
  }
});

test('真实 Git 对照：revert 普通提交与冲突继续/中止', t => {
  for (const mode of ['ordinary', 'resolve', 'abort']) {
    const f = fixture(t); f.edit('hello.txt', '第一次修改\n'); f.commit('第一次修改');
    if (mode !== 'ordinary') { f.edit('hello.txt', '第二次修改\n'); f.commit('第二次修改'); }
    const result = f.command('revert', mode === 'ordinary' ? 'HEAD' : 'HEAD~1');
    if (mode !== 'ordinary') {
      assert.equal(result.conflict, true);
      if (mode === 'abort') f.command('revert', '--abort');
      else { f.edit('hello.txt', '撤回解决结果\n'); f.command('add', '.'); f.command('revert', '--continue'); }
    }
    f.assertState();
  }
});

test('真实 Git 对照：离线裸仓库 fetch、pull 两种整合及 push 拒绝/成功', t => {
  for (const rebase of [false, true]) {
    const f = fixture(t), remotePath = path.resolve(f.directory, '../remote.git'), collaborator = path.resolve(f.directory, '../collaborator');
    f.git(['init', '--bare', '-b', 'main', remotePath]); f.git(['remote', 'add', 'origin', remotePath]); f.command('push', '-u', 'origin', 'main');
    f.git(['clone', remotePath, collaborator]);
    fs.writeFileSync(path.join(collaborator, 'team.txt'), '团队协作记录\n协作者更新 ' + f.sim.state.nextId + '\n', 'utf8');
    f.git(['add', '.'], false, collaborator); f.git(['commit', '-m', '协作者：在 team.txt 追加“协作者更新 ' + f.sim.state.nextId + '”'], false, collaborator); f.git(['push', 'origin', 'main'], false, collaborator);
    f.sim.simulateRemote();
    f.edit('notes.txt', '本地修改\n'); f.commit('本地提交'); assert.equal(f.command('push').ok, false);
    const before = f.sim.headId(); f.command('fetch'); assert.equal(f.sim.headId(), before);
    f.command('pull', rebase ? '--rebase' : '--no-rebase', 'origin', 'main'); f.command('push'); f.assertState();
    assert.deepEqual(f.sim.state.remote.commits[f.sim.state.remote.branches.main].tree, f.sim.headTree());
    const remoteTree = f.git(['rev-parse', 'main^{tree}'], false, remotePath).stdout.trim(); assert.equal(remoteTree, f.git(['rev-parse', 'HEAD^{tree}']).stdout.trim());
  }
});

test('真实 Git 对照：协作者只推进远程 dev，fetch 与 pull 不误移动 main', t => {
  const f = fixture(t), remotePath = path.resolve(f.directory, '../remote.git'), collaborator = path.resolve(f.directory, '../collaborator');
  f.git(['init', '--bare', '-b', 'main', remotePath]); f.git(['remote', 'add', 'origin', remotePath]); f.command('push', '-u', 'origin', 'main');
  f.command('switch', '-c', 'dev'); f.edit('hello.txt', 'dev 分支独有内容\n'); f.commit('准备 dev'); f.command('push', '-u', 'origin', 'dev'); f.command('switch', 'main');
  const main = f.git(['rev-parse', 'main'], false, remotePath).stdout.trim(), local = f.sim.snapshot();
  f.git(['clone', remotePath, collaborator]); f.git(['switch', '-c', 'dev', 'origin/dev'], false, collaborator);
  fs.writeFileSync(path.join(collaborator, 'team.txt'), '团队协作记录\n协作者更新 ' + f.sim.state.nextId + '\n', 'utf8');
  f.git(['add', '.'], false, collaborator); f.git(['commit', '-m', '协作者：在 team.txt 追加“协作者更新 ' + f.sim.state.nextId + '”'], false, collaborator); f.git(['push', 'origin', 'dev'], false, collaborator);
  const result = f.sim.simulateRemote('dev'); assert.equal(result.ok, true);
  assert.equal(f.sim.state.remote.branches.main, local.remote.branches.main); assert.equal(f.sim.state.tracking.dev, local.tracking.dev);
  f.command('fetch'); assert.equal(f.sim.state.tracking.dev, result.commitId); f.assertState();
  f.command('switch', 'dev'); f.command('pull', '--no-rebase', 'origin', 'dev'); f.assertState();
  assert.equal(f.git(['rev-parse', 'main'], false, remotePath).stdout.trim(), main);
  assert.equal(f.sim.state.branches.main, local.branches.main);
});

test('真实 Git 对照：协作者自由编辑多个文件，本地 fetch 后 pull 冲突并解决', t => {
  const f = fixture(t), remotePath = path.resolve(f.directory, '../remote.git'), collaborator = path.resolve(f.directory, '../collaborator');
  f.git(['init', '--bare', '-b', 'main', remotePath]); f.git(['remote', 'add', 'origin', remotePath]); f.command('push', '-u', 'origin', 'main'); f.git(['clone', remotePath, collaborator]);
  const draft = new RemoteWorkspace('main', f.sim.state.remote.commits[f.sim.state.remote.branches.main]);
  draft.editFile('hello.txt', draft.work['hello.txt'].replace('你好，Git！', '协作者的新问候'));
  draft.deleteFile('README.md'); draft.editFile('collaborator.txt', '协作者自定义的文件\n'); draft.stage('.');
  for (const [file, text] of Object.entries(draft.work)) fs.writeFileSync(path.join(collaborator, file), text, 'utf8');
  fs.unlinkSync(path.join(collaborator, 'README.md'));
  f.git(['add', '.'], false, collaborator); f.git(['commit', '-m', '调整问候并更新协作文件'], false, collaborator); f.git(['push', 'origin', 'main'], false, collaborator);
  assert.equal(f.sim.commitRemote('main', { baseId: draft.baseId, tree: draft.index, message: '调整问候并更新协作文件' }).ok, true);
  f.edit('hello.txt', f.sim.state.work['hello.txt'].replace('你好，Git！', '本地的新问候')); f.commit('本地修改问候');
  f.command('fetch'); f.assertState(); assert.equal(f.command('pull', '--no-rebase', 'origin', 'main').conflict, true);
  f.edit('hello.txt', '统一问候\n'); f.command('add', '.'); f.command('merge', '--continue'); f.assertState();
  assert.equal(f.sim.state.work['README.md'], undefined); assert.equal(f.sim.state.work['collaborator.txt'], '协作者自定义的文件\n');
});

test('真实 Git 对照：cherry-pick 只摘取指定补丁，多提交顺序一致', t => {
  const f = fixture(t); f.command('switch', '-c', 'source');
  f.edit('excluded.txt', '不摘取\n'); f.commit('来源一'); f.edit('selected.txt', '摘取\n'); f.commit('来源二');
  f.command('branch', 'pick-one'); f.edit('third.txt', '第三次\n'); f.commit('来源三'); f.command('switch', 'main');
  f.command('cherry-pick', 'pick-one', 'source'); f.assertState();
  assert.equal(f.sim.state.work['excluded.txt'], undefined);
});

test('真实 Git 对照：整批 cherry-pick 冲突、继续、跳过及中止', t => {
  for (const mode of ['continue', 'skip', 'abort']) {
    const f = fixture(t); f.command('switch', '-c', 'source');
    f.edit('first.txt', '第一份\n'); f.commit('第一份'); f.command('branch', 'pick-one');
    f.edit('hello.txt', '来源修改\n'); f.commit('冲突修改'); f.command('branch', 'pick-two');
    f.edit('last.txt', '最后一份\n'); f.commit('最后一份'); f.command('switch', 'main');
    f.edit('hello.txt', '主分支修改\n'); f.commit('主分支修改');
    assert.equal(f.command('cherry-pick', 'pick-one', 'pick-two', 'source').conflict, true);
    if (mode === 'continue') { f.edit('hello.txt', '解决结果\n'); f.command('add', '.'); }
    f.command('cherry-pick', '--' + mode); f.assertState();
  }
});

test('真实 Git 对照：cherry-pick 重复补丁暂停后 skip 或 abort', t => {
  for (const mode of ['skip', 'abort']) {
    const f = fixture(t); f.edit('hello.txt', '已经存在的修改\n'); f.commit('已存在');
    assert.equal(f.command('cherry-pick', 'HEAD').paused, true); f.command('cherry-pick', '--' + mode); f.assertState();
  }
});

test('真实 Git 对照：自动暂存、修订普通及合并提交，保留未暂存内容', t => {
  const f = fixture(t); f.edit('hello.txt', '自动暂存\n'); f.edit('new.txt', '未跟踪\n');
  f.command('commit', '-am', '自动提交'); f.assertState(); f.command('add', 'new.txt');
  f.edit('hello.txt', '尚未暂存\n'); f.command('commit', '--amend', '--no-edit'); f.assertState();
  f.command('restore', 'hello.txt'); f.command('commit', '--amend', '-m', '修订说明'); f.assertState();
  f.command('switch', '-c', 'feature'); f.edit('feature.txt', 'feature\n'); f.commit('分支修改');
  f.command('switch', 'main'); f.command('merge', '--no-ff', 'feature');
  f.command('commit', '--amend', '-m', '修订合并说明'); f.assertState();
  f.command('rm', '--cached', 'README.md'); f.command('commit', '-am', '取消跟踪'); f.assertState();
});

test('真实 Git 对照：rm、cached、mv 保留暂存与工作区的独立内容', t => {
  const f = fixture(t); f.edit('hello.txt', '暂存\n'); f.command('add', 'hello.txt'); f.edit('hello.txt', '工作\n');
  f.command('rm', 'hello.txt'); f.command('rm', '--cached', 'hello.txt'); f.assertState();
  f.command('mv', 'hello.txt', 'greeting.txt'); f.assertState(); f.command('add', 'greeting.txt');
  f.command('rm', '--cached', 'greeting.txt'); f.assertState(); f.command('commit', '-am', '取消跟踪'); f.assertState();
  f.command('rm', 'README.md'); f.assertState();
});

test('真实 Git 对照：branch 改名、switch 往返、detach 和 checkout 恢复文件', t => {
  const f = fixture(t); f.command('branch', '-m', 'trunk'); f.command('switch', '-c', 'feature'); f.command('switch', '-'); f.assertState();
  f.command('checkout', '-'); f.command('switch', '--detach', 'HEAD'); f.assertState(); f.command('switch', '-'); f.assertState();
  f.edit('hello.txt', '暂存\n'); f.command('add', 'hello.txt'); f.edit('hello.txt', '工作\n');
  f.command('checkout', '--', 'hello.txt'); f.assertState(); f.command('checkout', 'HEAD', '--', 'hello.txt'); f.assertState();
  f.command('branch', 'rescue', 'HEAD@{1}'); f.assertState();
});

test('真实 Git 对照：本地标签位置、选定 stash 的 apply、pop、drop 和 clear', t => {
  const f = fixture(t); f.command('tag', 'v1'); f.edit('hello.txt', '版本二\n'); f.commit('版本二'); f.command('tag', '-a', 'v2', '-m', '说明');
  f.command('checkout', 'v1'); f.assertState(); f.command('switch', 'main'); f.command('tag', '-d', 'v1');
  f.edit('hello.txt', 'one\n'); f.command('stash', 'push', '-m', 'one'); f.edit('hello.txt', 'two\n'); f.command('stash', 'push', '-m', 'two');
  f.command('stash', 'apply', 'stash@{1}'); f.assertState(); f.command('restore', '.');
  f.command('stash', 'pop', 'stash@{1}'); f.assertState(); f.command('stash', 'drop'); f.assertState();
  assert.equal(f.sim.state.stashes.length, 0); assert.equal(f.git(['stash', 'list']).stdout, '');
  f.command('stash', 'push'); f.command('stash', 'clear'); f.assertState(); assert.equal(f.git(['stash', 'list']).stdout, '');
});
