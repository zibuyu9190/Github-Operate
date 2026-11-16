const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, RemoteWorkspace } = require('../simulator.js');
const { complete, recommend } = require('../command-assist.js');

function fixture() {
  const sim = new Simulator();
  const peer = new RemoteWorkspace('main', sim.state.remote.commits[sim.state.remote.branches.main], sim.state.remote);
  const mine = () => Object.fromEntries(Object.entries(sim.snapshot()).filter(([key]) => !['remote', 'nextId'].includes(key)));
  const before = mine();
  const run = command => {
    const shared = structuredClone(sim.state.remote), result = peer.execute(sim, command);
    assert.equal(result.ok, true, command + '\n' + result.output);
    assert.deepEqual(mine(), before, '协作者命令不能修改我的本地：' + command);
    if (result.command.name !== 'push') assert.deepEqual(sim.state.remote, shared, '只有 push 能发布：' + command);
    return result;
  };
  const commit = (path, text, message = path) => { peer.editFile(path, text); run('git add .'); return run('git commit -m ' + JSON.stringify(message)).commitId; };
  return { sim, peer, run, commit };
}

test('协作者多分支共用工作区，提交切换后按分支恢复，能从非当前分支 push', () => {
  const { sim, peer, run, commit } = fixture(), base = peer.baseId;
  run('git switch -c dev'); assert.equal(peer.upstreams.dev, undefined);
  const tip = commit('peer.txt', 'dev 内容\n');
  assert.equal(peer.execute(sim, 'git push').ok, false);
  run('git switch main'); assert.equal(peer.baseId, base); assert.equal(peer.work['peer.txt'], undefined);
  run('git push origin dev'); assert.equal(sim.state.remote.branches.dev, tip); assert.equal(peer.branch, 'main'); assert.equal(peer.upstreams.dev, undefined);
  run('git switch dev'); run('git push -u origin dev'); assert.equal(peer.upstreams.dev, 'dev');
  run('git switch -'); assert.equal(peer.branch, 'main');
  run('git branch -m dev feature'); assert.equal(peer.branches.feature, tip); assert.equal(peer.upstreams.feature, 'dev');
  run('git switch feature'); assert.equal(peer.work['peer.txt'], 'dev 内容\n');
});

test('协作者切换保护会拒绝覆盖，失败不能创建半成品分支或丢失暂存状态', () => {
  const { sim, peer, run, commit } = fixture();
  run('git checkout -b dev'); commit('hello.txt', 'dev 版本\n'); run('git switch main');
  peer.editFile('hello.txt', '尚未提交\n'); run('git add hello.txt'); peer.editFile('hello.txt', '再次编辑\n');
  const before = structuredClone(peer), shared = sim.snapshot();
  assert.equal(peer.execute(sim, 'git switch dev').ok, false);
  assert.deepEqual(structuredClone(peer), before); assert.deepEqual(sim.snapshot(), shared);
  run('git stash push -u -m "切分支前保存"'); run('git switch dev'); run('git switch main'); run('git stash pop');
  assert.equal(peer.work['hello.txt'], '再次编辑\n'); assert.equal(peer.stashes.length, 0);
});

test('协作者新远程分支须 fetch，switch 和 checkout 自动建立同名跟踪分支', () => {
  const { sim, peer } = fixture();
  sim.execute('git switch -c teammate'); sim.editFile('other.txt', '远程文件\n'); sim.execute('git add .'); sim.execute('git commit -m "远程新分支"'); sim.execute('git push -u origin teammate');
  assert.equal(peer.execute(sim, 'git switch teammate').ok, false);
  // 这个场景主动变更了“我的本地”，重新固定隔离基准。
  const mine = sim.snapshot();
  assert.equal(peer.execute(sim, 'git fetch').ok, true);
  const result = peer.execute(sim, 'git checkout teammate'); assert.equal(result.ok, true, result.output);
  assert.equal(peer.branch, 'teammate'); assert.equal(peer.upstreams.teammate, 'teammate'); assert.equal(peer.work['other.txt'], '远程文件\n');
  assert.deepEqual(sim.snapshot(), mine);
});

for (const operation of ['merge', 'rebase', 'cherry-pick']) test('协作者 ' + operation + ' 保存多分支历史并可继续或中止冲突', () => {
  for (const abort of [false, true]) {
    const { sim, peer, run, commit } = fixture();
    run('git switch -c dev'); const source = commit('hello.txt', 'dev\n');
    run('git switch main'); const target = commit('hello.txt', 'main\n');
    const input = 'git ' + operation + ' ' + (operation === 'cherry-pick' ? source : 'dev');
    assert.equal(run(input).conflict, true);
    assert.ok(peer.pending); assert.equal(peer.execute(sim, 'git switch dev').ok, false);
    if (abort) {
      run('git ' + operation + ' --abort'); assert.equal(peer.baseId, target); assert.equal(peer.work['hello.txt'], 'main\n');
    } else {
      peer.editFile('hello.txt', '整合内容\n'); run('git add .'); run('git ' + operation + ' --continue');
      assert.equal(peer.work['hello.txt'], '整合内容\n'); assert.equal(peer.commits[peer.baseId].parents.length, operation === 'merge' ? 2 : 1);
      run('git push'); assert.equal(sim.state.remote.branches.main, peer.baseId);
    }
    assert.equal(peer.branches.dev, source); assert.equal(peer.pending, null);
  }
});

test('协作者 cherry-pick 可跳过空改动，revert 冲突可继续和中止', () => {
  const { peer, run, commit } = fixture();
  const added = commit('peer.txt', '初版\n');
  assert.equal(run('git cherry-pick ' + added).paused, true); run('git cherry-pick --skip'); assert.equal(peer.pending, null);
  commit('peer.txt', '新版\n'); assert.equal(run('git revert ' + added).conflict, true); run('git revert --abort');
  assert.equal(peer.work['peer.txt'], '新版\n');
  run('git revert ' + added); peer.deleteFile('peer.txt'); run('git add .'); run('git revert --continue');
  assert.equal(peer.work['peer.txt'], undefined);
});

for (const mode of ['soft', 'mixed', 'hard']) test('协作者 reset --' + mode + ' 正确移动引用且不改远程', () => {
  const { peer, run, commit } = fixture(), original = peer.base['hello.txt'];
  const parent = peer.baseId, tip = commit('hello.txt', '已提交修改\n');
  run('git reset --' + mode + ' HEAD~1'); assert.equal(peer.baseId, parent);
  assert.equal(peer.index['hello.txt'], mode === 'soft' ? '已提交修改\n' : original);
  assert.equal(peer.work['hello.txt'], mode === 'hard' ? original : '已提交修改\n');
  assert.equal(peer.reflog[0].id, parent); assert.ok(peer.commits[tip]);
});

test('协作者 amend、标签、reflog、分离 HEAD、文件改名与删除可跨命令保留', () => {
  const { peer, run, commit } = fixture();
  run('git remote -v'); const old = commit('peer.txt', '初版\n');
  peer.editFile('peer.txt', '修订\n'); run('git add .'); run('git commit --amend --no-edit');
  const revised = peer.baseId; assert.notEqual(revised, old); assert.deepEqual(peer.commits[revised].parents, peer.commits[old].parents);
  run('git tag -a v1.0 -m "协作者版本"'); run('git mv peer.txt renamed.txt'); run('git commit -m "文件改名"');
  run('git rm --cached renamed.txt'); assert.equal(peer.work['renamed.txt'], '修订\n'); assert.equal(peer.index['renamed.txt'], undefined);
  run('git restore --staged renamed.txt'); run('git rm renamed.txt'); run('git commit -m "删除文件"');
  run('git checkout v1.0'); assert.equal(peer.branch, null); assert.equal(peer.head.id, revised); assert.equal(peer.work['peer.txt'], '修订\n');
  run('git switch -c rescued'); run('git switch main'); run('git branch -d rescued'); run('git tag -d v1.0');
  assert.match(run('git reflog').output, /commit --amend/); assert.equal(peer.tags['v1.0'], undefined);
});

test('协作者 stash 冲突不推荐不存在的 continue/abort，解决后记录仍保留', () => {
  const { sim, peer, run, commit } = fixture();
  peer.editFile('hello.txt', 'stash 文本\n'); run('git stash push'); commit('hello.txt', '新提交文本\n');
  assert.equal(run('git stash pop').conflict, true);
  const context = peer.commandContext(sim);
  assert.ok(!recommend(context).some(item => /stash --(continue|abort)/.test(item.command)));
  peer.editFile('hello.txt', '最终结果\n'); run('git add .'); assert.equal(peer.pending, null); assert.equal(peer.stashes.length, 1);
  run('git stash drop'); assert.equal(peer.stashes.length, 0);
});

test('协作者补全覆盖本地同等命令，引用、stash 和推荐只来自协作者', () => {
  const { sim, peer } = fixture();
  sim.execute('git branch private-mine');
  peer.editFile('hello.txt', '未提交\n'); assert.equal(peer.execute(sim, 'git stash push').ok, true);
  assert.equal(peer.execute(sim, 'git switch -c peer-only').ok, true);
  const context = peer.commandContext(sim), choices = input => complete(input, input.length, context, true);
  for (const command of ['switch', 'checkout', 'stash', 'reset', 'revert', 'rebase', 'merge', 'cherry-pick', 'branch', 'tag', 'reflog', 'rm', 'mv', 'remote']) {
    const input = 'git ' + command.slice(0, -1);
    assert.ok(choices(input).some(item => item.label === command), command);
  }
  assert.ok(choices('git switch ').some(item => item.label === 'peer-only'));
  assert.ok(!choices('git switch ').some(item => item.label === 'private-mine'));
  assert.ok(choices('git stash pop ').some(item => item.label === 'stash@{0}'));
  assert.ok(recommend(context).some(item => item.command === 'git push -u origin peer-only'));
});
