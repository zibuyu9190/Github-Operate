const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator } = require('../simulator.js');
const { parse } = require('../commands.js');
const { complete, recommend } = require('../command-assist.js');

function run(sim, command) {
  const result = sim.execute(command);
  assert.equal(result.ok, true, command + ': ' + result.output);
  return result;
}
function commit(sim, file, text, message = file) {
  sim.editFile(file, text); run(sim, 'git add .'); run(sim, 'git commit -m "' + message + '"');
  return sim.headId();
}
const context = sim => ({ state: sim.state, files: sim.fileStatus(), scene: sim.scene });
function rejected(sim, command) {
  const before = sim.snapshot(); assert.equal(sim.execute(command).ok, false, command); assert.deepEqual(sim.snapshot(), before, command);
}
function pickFixture() {
  const sim = new Simulator(); run(sim, 'git switch -c source');
  const first = commit(sim, 'first.txt', 'first\n');
  const second = commit(sim, 'hello.txt', 'source\n');
  const third = commit(sim, 'third.txt', 'third\n');
  run(sim, 'git switch main'); commit(sim, 'hello.txt', 'main\n');
  return { sim, first, second, third };
}

test('新增命令拒绝未支持参数、引用及不完整写法，保持全部状态', () => {
  const sim = new Simulator();
  for (const command of ['git cherry-pick', 'git cherry-pick -n main', 'git cherry-pick main..other', 'git cherry-pick main missing', 'git commit --amend', 'git commit --no-edit', 'git commit --amend --no-edit -m x', 'git tag -a v1', 'git tag -a v1 -m x extra', 'git rm -f hello.txt', 'git mv hello.txt', 'git reflog --all', 'git branch -M next', 'git switch --detach missing', 'git switch --detach ""', 'git checkout HEAD -- . missing.txt', 'git stash apply stash@{99}']) rejected(sim, command);
  assert.deepEqual(parse('git commit -am "修复"'), { name: 'commit', message: '修复', amend: false, all: true });
  assert.deepEqual(parse('git cherry-pick C1 C2').refs, ['C1', 'C2']);
});

test('cherry-pick 只应用指定提交相对父提交的改动，来源不移动', () => {
  const sim = new Simulator(); run(sim, 'git switch -c source');
  commit(sim, 'unwanted.txt', '不摘取这次提交\n'); const selected = commit(sim, 'wanted.txt', '需要这次改动\n');
  run(sim, 'git switch main'); const previous = sim.headId();
  run(sim, 'git cherry-pick ' + selected);
  assert.equal(sim.state.work['unwanted.txt'], undefined); assert.equal(sim.state.work['wanted.txt'], '需要这次改动\n');
  assert.equal(sim.state.branches.source, selected); assert.notEqual(sim.headId(), selected);
  assert.deepEqual(sim.state.commits[sim.headId()].parents, [previous]); assert.equal(sim.isClean(), true);
});

test('多个 cherry-pick 按指定顺序生成普通提交，拒绝合并提交和脏工作区', () => {
  const sim = new Simulator(); run(sim, 'git switch -c source');
  const first = commit(sim, 'first.txt', 'one\n'), second = commit(sim, 'second.txt', 'two\n');
  run(sim, 'git switch main'); const start = sim.headId(); run(sim, 'git cherry-pick ' + second + ' ' + first);
  const tip = sim.state.commits[sim.headId()], parent = sim.state.commits[tip.parents[0]];
  assert.equal(tip.message, 'first.txt'); assert.equal(parent.message, 'second.txt'); assert.deepEqual(parent.parents, [start]);
  run(sim, 'git merge --no-ff source'); const merge = sim.headId(); run(sim, 'git switch source');
  rejected(sim, 'git cherry-pick ' + merge);
  sim.editFile('loose.txt', '未跟踪\n'); rejected(sim, 'git cherry-pick main');
});

test('cherry-pick 冲突需编辑并 add 后继续，后续提交继续重放', () => {
  const { sim, first, second, third } = pickFixture(), start = sim.headId();
  assert.equal(run(sim, 'git cherry-pick ' + [first, second, third].join(' ')).conflict, true);
  assert.equal(sim.state.work['first.txt'], 'first\n'); assert.equal(sim.state.work['third.txt'], undefined);
  assert.equal(sim.state.pending.cursor, 1); assert.match(sim.state.work['hello.txt'], /<<<<<<< HEAD[\s\S]*=======/);
  rejected(sim, 'git cherry-pick --continue'); rejected(sim, 'git commit -m "错误绕过"');
  sim.editFile('hello.txt', '合并结果\n'); rejected(sim, 'git cherry-pick --continue'); run(sim, 'git add hello.txt');
  sim.editFile('hello.txt', '再次编辑\n'); rejected(sim, 'git cherry-pick --continue'); run(sim, 'git add hello.txt');
  run(sim, 'git cherry-pick --continue');
  assert.equal(sim.state.pending, null); assert.equal(sim.state.work['hello.txt'], '再次编辑\n'); assert.equal(sim.state.work['third.txt'], 'third\n');
  assert.equal(sim.resolve('HEAD~3'), start); assert.equal(sim.state.branches.source, third);
});

test('cherry-pick 中止恢复整批起点，跳过只放弃当前提交', () => {
  for (const action of ['abort', 'skip']) {
    const { sim, first, second, third } = pickFixture(), initial = sim.snapshot(), start = sim.headId();
    run(sim, 'git cherry-pick ' + [first, second, third].join(' ')); sim.editFile('hello.txt', '未保存的解决\n');
    run(sim, 'git cherry-pick --' + action);
    assert.equal(sim.state.pending, null); assert.equal(sim.state.work['hello.txt'], 'main\n');
    if (action === 'abort') {
      assert.equal(sim.headId(), start); assert.deepEqual(sim.state.branches, initial.branches);
      assert.deepEqual(sim.state.index, initial.index); assert.deepEqual(sim.state.work, initial.work);
    } else { assert.equal(sim.state.work['first.txt'], 'first\n'); assert.equal(sim.state.work['third.txt'], 'third\n'); assert.equal(sim.resolve('HEAD~2'), start); }
  }
});

test('cherry-pick 可连续暂停在不同冲突，并中止已成功解决的批次', () => {
  const sim = new Simulator(); run(sim, 'git switch -c source');
  const first = commit(sim, 'hello.txt', 'source one\n'), second = commit(sim, 'README.md', 'source two\n');
  run(sim, 'git switch main'); sim.editFile('hello.txt', 'main one\n'); commit(sim, 'README.md', 'main two\n');
  const start = sim.headId(), tree = structuredClone(sim.headTree()); run(sim, 'git cherry-pick ' + first + ' ' + second);
  sim.editFile('hello.txt', 'resolved one\n'); run(sim, 'git add .'); assert.equal(run(sim, 'git cherry-pick --continue').conflict, true);
  assert.deepEqual(sim.state.pending.unresolved, ['README.md']); assert.notEqual(sim.headId(), start);
  run(sim, 'git cherry-pick --abort'); assert.equal(sim.headId(), start); assert.deepEqual(sim.state.work, tree);
});

test('重复摘取、根提交和解决为空时暂停，skip 不制造空提交', () => {
  const sim = new Simulator(); const first = commit(sim, 'hello.txt', '第一次修改\n');
  assert.equal(run(sim, 'git cherry-pick ' + first).paused, true); const count = Object.keys(sim.state.commits).length;
  rejected(sim, 'git cherry-pick --continue');
  assert.ok(!recommend(context(sim)).some(x => x.command === 'git cherry-pick --continue'));
  assert.ok(!complete('git cherry-pick --', 18, context(sim)).some(x => x.label === '--continue'));
  run(sim, 'git cherry-pick --skip'); assert.equal(Object.keys(sim.state.commits).length, count);
  run(sim, 'git rm hello.txt'); run(sim, 'git rm README.md'); run(sim, 'git commit -m "清空"');
  run(sim, 'git cherry-pick C0'); assert.deepEqual(sim.state.work, sim.state.commits.C0.tree);
  const fixture = pickFixture(); run(fixture.sim, 'git cherry-pick ' + fixture.second);
  fixture.sim.editFile('hello.txt', 'main\n'); run(fixture.sim, 'git add .'); rejected(fixture.sim, 'git cherry-pick --continue');
  run(fixture.sim, 'git cherry-pick --skip'); assert.equal(fixture.sim.state.pending, null);
});

test('commit -am 忽略未跟踪文件，amend 保留父关系和未暂存改动', () => {
  const sim = new Simulator(); sim.editFile('hello.txt', '已跟踪修改\n'); sim.editFile('new.txt', '未跟踪\n');
  run(sim, 'git commit -am "自动暂存"'); assert.equal(sim.headTree()['new.txt'], undefined); assert.equal(sim.state.work['new.txt'], '未跟踪\n');
  const original = sim.headId(), parents = sim.state.commits[original].parents;
  sim.editFile('hello.txt', '补充暂存\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', '尚未暂存\n');
  run(sim, 'git commit --amend --no-edit'); assert.notEqual(sim.headId(), original); assert.deepEqual(sim.state.commits[sim.headId()].parents, parents);
  assert.equal(sim.headTree()['hello.txt'], '补充暂存\n'); assert.equal(sim.state.work['hello.txt'], '尚未暂存\n');
  assert.equal(sim.state.commits[sim.headId()].message, '自动暂存'); assert.equal(sim.resolve('HEAD@{1}'), original);
  run(sim, 'git restore hello.txt'); run(sim, 'git commit --amend -m "只改说明"'); assert.equal(sim.state.commits[sim.headId()].message, '只改说明');
  run(sim, 'git rm --cached README.md'); run(sim, 'git commit -am "取消跟踪"');
  assert.equal(sim.headTree()['README.md'], undefined); assert.ok(sim.state.work['README.md']);
});

test('rm 保护未提交内容、cached 保留工作区、mv 保留暂存与工作区差别', () => {
  const sim = new Simulator(); sim.editFile('hello.txt', '暂存\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', '工作\n');
  rejected(sim, 'git rm hello.txt'); rejected(sim, 'git rm --cached hello.txt');
  run(sim, 'git mv hello.txt greeting.txt'); assert.equal(sim.state.index['greeting.txt'], '暂存\n'); assert.equal(sim.state.work['greeting.txt'], '工作\n');
  assert.equal(sim.state.work['hello.txt'], undefined); rejected(sim, 'git mv greeting.txt README.md'); rejected(sim, 'git rm README.md missing.txt');
  run(sim, 'git add greeting.txt'); run(sim, 'git rm --cached greeting.txt'); assert.equal(sim.state.work['greeting.txt'], '工作\n'); assert.equal(sim.state.index['greeting.txt'], undefined);
  run(sim, 'git rm README.md'); assert.equal(sim.state.work['README.md'], undefined); assert.equal(sim.state.index['README.md'], undefined);
});

test('tag 固定提交并参与可达历史，reflog 可创建救援分支', () => {
  const sim = new Simulator(); const id = commit(sim, 'hello.txt', '标签版本\n'); run(sim, 'git tag -a v1 -m "正式版"');
  run(sim, 'git reset --hard HEAD~1'); assert.equal(sim.resolve('v1'), id); assert.match(run(sim, 'git log --all').output, new RegExp(id));
  run(sim, 'git branch rescue HEAD@{1}'); assert.equal(sim.state.branches.rescue, id); assert.equal(sim.state.tags.v1.message, '正式版');
  rejected(sim, 'git tag v1'); const before = sim.snapshot(); run(sim, 'git reflog --oneline'); run(sim, 'git tag -l'); assert.deepEqual(sim.snapshot(), before);
  run(sim, 'git tag -d v1'); rejected(sim, 'git show v1'); sim.loadScene('basic'); assert.equal(sim.state.reflog.length, 1); assert.deepEqual(sim.state.tags, {});
});

test('分支改名保留上游，switch -、分离 HEAD 与 checkout 文件恢复各司其职', () => {
  const sim = new Simulator(), base = sim.headTree()['hello.txt']; run(sim, 'git branch -m trunk'); assert.equal(sim.state.head.branch, 'trunk'); assert.equal(sim.state.upstreams.trunk, 'main');
  run(sim, 'git switch -c feature'); run(sim, 'git switch -'); assert.equal(sim.state.head.branch, 'trunk');
  run(sim, 'git checkout -'); assert.equal(sim.state.head.branch, 'feature'); run(sim, 'git switch --detach HEAD'); assert.equal(sim.state.head.branch, null);
  run(sim, 'git switch -'); assert.equal(sim.state.head.branch, 'feature');
  sim.editFile('hello.txt', '暂存\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', '工作\n'); run(sim, 'git checkout -- hello.txt'); assert.equal(sim.state.work['hello.txt'], '暂存\n');
  const head = sim.headId(); run(sim, 'git checkout HEAD -- hello.txt'); assert.equal(sim.headId(), head); assert.equal(sim.state.index['hello.txt'], base); assert.equal(sim.state.work['hello.txt'], base);
});

test('stash apply、指定 pop/drop 与 clear 的记录和文件相互独立', () => {
  const sim = new Simulator(); sim.editFile('hello.txt', 'one\n'); run(sim, 'git stash push -m one'); sim.editFile('hello.txt', 'two\n'); run(sim, 'git stash push -m two');
  run(sim, 'git stash apply stash@{1}'); assert.equal(sim.state.work['hello.txt'], 'one\n'); assert.equal(sim.state.stashes.length, 2);
  run(sim, 'git restore .'); run(sim, 'git stash pop stash@{1}'); assert.equal(sim.state.stashes.length, 1); assert.equal(sim.state.stashes[0].message, 'two');
  run(sim, 'git stash drop'); assert.equal(sim.state.stashes.length, 0); assert.equal(sim.state.work['hello.txt'], 'one\n');
  run(sim, 'git stash push'); run(sim, 'git stash clear'); assert.equal(sim.state.stashes.length, 0); assert.equal(sim.isClean(), true);
});

test('新增补全提供标签、历史位置与冲突操作，推荐不越过解决步骤', () => {
  const { sim, second } = pickFixture(); run(sim, 'git tag v1');
  const choices = input => complete(input, input.length, context(sim));
  assert.equal(choices('git cher')[0].value, 'git cherry-pick ');
  assert.ok(choices('git cherry-pick v').some(x => x.label === 'v1')); assert.ok(choices('git branch rescue HEAD@').some(x => x.label === 'HEAD@{1}'));
  assert.ok(choices('git rm ').some(x => x.label === '--cached')); assert.ok(choices('git checkout -- ').some(x => x.label === 'hello.txt'));
  sim.editFile('loose.txt', '未跟踪\n'); assert.ok(!choices('git checkout -- ').some(x => x.label === 'loose.txt')); sim.deleteFile('loose.txt');
  run(sim, 'git cherry-pick ' + second); assert.ok(choices('git cherry-pick --').some(x => x.label === '--skip'));
  assert.ok(!recommend(context(sim)).some(x => /--continue/.test(x.command)));
  sim.editFile('hello.txt', '解决\n'); run(sim, 'git add .'); assert.ok(recommend(context(sim)).some(x => x.command === 'git cherry-pick --continue'));
});
