const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Simulator } = require('../simulator.js');

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
      cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    });
    if (!allowedFailure) assert.equal(result.status, 0, args.join(' ') + '\n' + result.stderr + result.stdout);
    return result;
  };
  const sim = new Simulator();
  git(['init', '-b', 'main']);
  const edit = (file, text) => { sim.editFile(file, text); fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), text, 'utf8'); };
  for (const [file, text] of Object.entries(sim.headTree())) fs.writeFileSync(path.join(directory, file), text, 'utf8');
  git(['add', '.']); git(['commit', '-m', '初始化练习仓库']);
  const command = (...args) => {
    const encoded = ['git', ...args.map(x => /\s/.test(x) ? '"' + x.replaceAll('"', '\\"') + '"' : x)].join(' ');
    const result = sim.execute(encoded), actual = git(args, true);
    assert.equal(result.ok && !result.conflict, actual.status === 0, encoded + '\n模拟：' + result.output + '\n实际：' + actual.stderr + actual.stdout);
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
    f.git(['add', '.'], false, collaborator); f.git(['commit', '-m', '协作者：更新团队记录'], false, collaborator); f.git(['push', 'origin', 'main'], false, collaborator);
    f.sim.simulateRemote();
    f.edit('notes.txt', '本地修改\n'); f.commit('本地提交'); assert.equal(f.command('push').ok, false);
    const before = f.sim.headId(); f.command('fetch'); assert.equal(f.sim.headId(), before);
    f.command('pull', rebase ? '--rebase' : '--no-rebase', 'origin', 'main'); f.command('push'); f.assertState();
    assert.deepEqual(f.sim.state.remote.commits[f.sim.state.remote.branches.main].tree, f.sim.headTree());
    const remoteTree = f.git(['rev-parse', 'main^{tree}'], false, remotePath).stdout.trim(); assert.equal(remoteTree, f.git(['rev-parse', 'HEAD^{tree}']).stdout.trim());
  }
});
