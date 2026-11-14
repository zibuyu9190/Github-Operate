const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, SCENES, mergeText } = require('../simulator.js');
const { parse, tokenize } = require('../commands.js');

function run(sim, command) {
  const result = sim.execute(command);
  assert.equal(result.ok, true, command + ': ' + result.output);
  return result;
}

function change(sim, path, text, message = '修改文件') {
  sim.editFile(path, text); run(sim, 'git add .'); run(sim, 'git commit -m "' + message + '"');
}

test('解析引号、中文、空格文件名及空字符串，拒绝歧义参数', () => {
  assert.deepEqual(tokenize('git add "hello world.txt"'), ['git', 'add', 'hello world.txt']);
  assert.equal(parse('git commit -m "中文 \\"引号\\""'.replace(/\\\\/g, '\\')).name, 'commit');
  assert.equal(parse("git commit -m '中文说明'").message, '中文说明');
  assert.equal(parse('git reset HEAD~1').mode, 'mixed');
  for (const command of ['git status --unknown', 'git merge --no-ff', 'git reset --hard --soft', 'git pull --rebase --no-rebase', 'git push -u origin', 'git add . && git commit', 'git commit -m "', 'git commit -m ""', 'git stash drop --all']) assert.throws(() => parse(command), command);
});

test('语法及语义错误均保持完整仓库状态，不留下半成品分支', () => {
  const sim = new Simulator();
  for (const command of ['git checkout -b main', 'git add missing.txt hello.txt', 'git add . missing.txt', 'git branch __proto__', 'git reset C999', 'git merge --wrong main', 'git switch C0']) {
    const before = sim.snapshot(); assert.equal(sim.execute(command).ok, false, command); assert.deepEqual(sim.snapshot(), before);
  }
});

test('暂存快照与后续编辑独立，提交只保存已暂存内容', () => {
  const sim = new Simulator();
  sim.editFile('hello.txt', '暂存版本\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', '最新草稿\n');
  run(sim, 'git commit -m "暂存快照"');
  assert.equal(sim.headTree()['hello.txt'], '暂存版本\n'); assert.equal(sim.state.work['hello.txt'], '最新草稿\n');
  assert.equal(sim.fileStatus().find(f => f.path === 'hello.txt').unstaged, true);
});

test('空提交拒绝，空文件可提交，删除会经 add 进入快照', () => {
  const sim = new Simulator(); assert.equal(sim.execute('git commit -m "空提交"').ok, false);
  change(sim, 'empty.txt', ''); assert.equal(sim.headTree()['empty.txt'], '');
  sim.deleteFile('empty.txt'); run(sim, 'git add .'); run(sim, 'git commit -m "删除空文件"'); assert.equal(Object.hasOwn(sim.headTree(), 'empty.txt'), false);
});

test('工作区与暂存区分别产生 diff；未跟踪文件不出现在普通 diff 中', () => {
  const sim = new Simulator(); sim.editFile('new.txt', 'new\n'); assert.equal(run(sim, 'git diff').output, '没有差异。');
  sim.editFile('hello.txt', 'stage\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', 'work\n');
  assert.match(run(sim, 'git diff --cached').output, /\+stage/); assert.match(run(sim, 'git diff').output, /-stage[\s\S]*\+work/);
});

test('分支创建不切换；切换拒绝覆盖修改，非重叠改动可以携带', () => {
  const sim = new Simulator(); run(sim, 'git branch feature'); assert.equal(sim.state.head.branch, 'main');
  change(sim, 'hello.txt', '主分支内容\n'); sim.editFile('hello.txt', '未保存的分支改动\n');
  assert.equal(sim.execute('git switch feature').ok, false); assert.equal(sim.state.head.branch, 'main');
  run(sim, 'git reset --hard'); sim.editFile('unrelated.txt', '保留\n'); run(sim, 'git switch feature'); assert.equal(sim.state.work['unrelated.txt'], '保留\n');
});

test('分离 HEAD 可创建提交，再通过新分支保留；引用支持祖先与短 ID', () => {
  const sim = new Simulator('reset'); const first = sim.resolve('HEAD~2');
  assert.equal(first, 'C0'); assert.equal(sim.resolve('HEAD^^'), first); assert.equal(sim.resolve('0000001'), first);
  run(sim, 'git checkout HEAD~1'); assert.equal(sim.state.head.branch, null);
  change(sim, 'detached.txt', '脱离分支\n'); const id = sim.headId(); run(sim, 'git switch -c saved'); assert.equal(sim.state.branches.saved, id);
});

test('快进合并不新增提交；--no-ff 创建两个父提交', () => {
  for (const noFF of [false, true]) {
    const sim = new Simulator(); run(sim, 'git switch -c feature'); change(sim, 'feature.txt', 'feature\n'); const tip = sim.headId();
    run(sim, 'git switch main'); const old = sim.headId(), count = Object.keys(sim.state.commits).length;
    run(sim, 'git merge ' + (noFF ? '--no-ff ' : '') + 'feature');
    assert.equal(Object.keys(sim.state.commits).length, count + (noFF ? 1 : 0));
    if (noFF) assert.deepEqual(sim.state.commits[sim.headId()].parents, [old, tip]); else assert.equal(sim.headId(), tip);
  }
});

test('不同文件和同一文件有共同上下文的非重叠改动自动合并', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const result = mergeText(base, 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n', 'feature');
  assert.equal(result.conflict, false); assert.equal(result.text, 'A\nb\nc\nd\nE\n');
  const sim = new Simulator('branches'); const result2 = run(sim, 'git merge bugFix'); assert.equal(result2.conflict, undefined);
  assert.equal(sim.state.commits[sim.headId()].parents.length, 2); assert.match(sim.headTree()['hello.txt'], /修复后的/);
});

test('合并冲突不移动 HEAD，解决并 add 后才能继续', () => {
  const sim = new Simulator('conflict'), old = sim.headId();
  assert.equal(run(sim, 'git merge bugFix').conflict, true); assert.equal(sim.headId(), old); assert.match(sim.state.work['hello.txt'], /<<<<<<< HEAD/);
  assert.match(run(sim, 'git diff --cached').output, /未合并路径：hello.txt/);
  assert.equal(sim.execute('git merge --continue').ok, false);
  sim.editFile('hello.txt', '统一问候\n'); run(sim, 'git add hello.txt'); run(sim, 'git merge --continue');
  assert.equal(sim.state.pending, null); assert.equal(sim.headTree()['hello.txt'], '统一问候\n'); assert.equal(sim.state.commits[sim.headId()].parents.length, 2);
});

test('修改/删除冲突保留版本，并允许选择删除作为解决结果', () => {
  const sim = new Simulator(); run(sim, 'git branch other');
  sim.deleteFile('hello.txt'); run(sim, 'git add .'); run(sim, 'git commit -m "删除"');
  run(sim, 'git switch other'); change(sim, 'hello.txt', '另一分支修改\n');
  assert.equal(run(sim, 'git merge main').conflict, true); assert.equal(sim.state.pending.conflicts['hello.txt'].theirs, null);
  sim.deleteFile('hello.txt'); run(sim, 'git add hello.txt'); run(sim, 'git commit -m "解决删除冲突"'); assert.equal(Object.hasOwn(sim.headTree(), 'hello.txt'), false);
});

test('中止合并恢复文件、暂存和分支；待处理时阻止不兼容操作', () => {
  const sim = new Simulator('conflict'), before = sim.snapshot(); run(sim, 'git merge bugFix');
  assert.equal(sim.execute('git switch bugFix').ok, false); run(sim, 'git merge --abort');
  assert.deepEqual(sim.state.branches, before.branches); assert.deepEqual(sim.state.work, before.work); assert.deepEqual(sim.state.index, before.index);
});

test('连续变基按顺序生成新提交，旧对象不修改，完成时分支才移动', () => {
  const sim = new Simulator('rebase'); change(sim, 'extra.txt', '第二次修复\n'); const old = sim.headId(), originals = structuredClone(sim.state.commits);
  run(sim, 'git rebase main'); assert.equal(sim.state.head.branch, 'bugFix'); assert.notEqual(sim.headId(), old);
  assert.equal(sim.isAncestor(sim.state.branches.main, sim.headId()), true); assert.equal(sim.headTree()['extra.txt'], '第二次修复\n');
  for (const id of Object.keys(originals)) assert.deepEqual(sim.state.commits[id], originals[id]);
});

test('变基冲突可以解决后继续，或中止恢复原分支与文件', () => {
  for (const abort of [false, true]) {
    const sim = new Simulator('conflict'); run(sim, 'git switch bugFix'); const old = sim.headId(), tree = structuredClone(sim.headTree());
    assert.equal(run(sim, 'git rebase main').conflict, true); assert.equal(sim.state.head.branch, null); assert.equal(sim.state.branches.bugFix, old);
    if (abort) { run(sim, 'git rebase --abort'); assert.equal(sim.headId(), old); assert.deepEqual(sim.state.work, tree); }
    else { sim.editFile('hello.txt', '变基解决\n'); run(sim, 'git add .'); run(sim, 'git rebase --continue'); assert.equal(sim.state.head.branch, 'bugFix'); assert.equal(sim.headTree()['hello.txt'], '变基解决\n'); }
  }
});

test('拒绝重放合并提交，失败不改变状态', () => {
  const sim = new Simulator('branches'); run(sim, 'git merge bugFix');
  run(sim, 'git checkout C0'); run(sim, 'git switch -c diverged'); change(sim, 'diverge.txt', 'new\n'); run(sim, 'git switch main');
  const before = sim.snapshot(); assert.equal(sim.execute('git rebase diverged').ok, false); assert.deepEqual(sim.snapshot(), before);
});

for (const mode of ['soft', 'mixed', 'hard']) test('reset --' + mode + ' 精确区分三个快照', () => {
  const sim = new Simulator('reset'), target = sim.resolve('HEAD~1'), targetTree = structuredClone(sim.state.commits[target].tree);
  sim.editFile('hello.txt', 'stage\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', 'work\n'); sim.editFile('keep.txt', '未跟踪\n');
  const before = sim.snapshot(); run(sim, 'git reset --' + mode + ' HEAD~1');
  assert.equal(sim.headId(), target); assert.deepEqual(sim.state.index, mode === 'soft' ? before.index : targetTree);
  assert.deepEqual(sim.state.work, mode === 'hard' ? { ...targetTree, 'keep.txt': '未跟踪\n' } : before.work);
});

test('revert 创建反向提交，保留原历史；支持冲突继续/中止与根提交', () => {
  const sim = new Simulator('reset'), old = sim.headId(), expected = structuredClone(sim.state.commits[sim.resolve('HEAD~1')].tree);
  run(sim, 'git revert HEAD'); assert.equal(sim.isAncestor(old, sim.headId()), true); assert.deepEqual(sim.headTree(), expected);
  for (const abort of [true, false]) {
    const conflict = new Simulator(); change(conflict, 'hello.txt', '第一次修改\n'); const id = conflict.headId(); change(conflict, 'hello.txt', '第二次修改\n');
    const before = conflict.snapshot(); assert.equal(run(conflict, 'git revert ' + id).conflict, true);
    if (abort) { run(conflict, 'git revert --abort'); assert.deepEqual(conflict.state.work, before.work); }
    else { conflict.editFile('hello.txt', '人工撤回\n'); run(conflict, 'git add .'); run(conflict, 'git revert --continue'); assert.equal(conflict.headTree()['hello.txt'], '人工撤回\n'); }
  }
  const root = new Simulator(); run(root, 'git revert HEAD'); assert.deepEqual(root.headTree(), {});
});

test('远程实际状态独立推进，fetch 仅更新对象及 tracking', () => {
  const sim = new Simulator(), before = sim.snapshot(); sim.simulateRemote(); const remote = sim.state.remote.branches.main;
  assert.equal(sim.state.tracking.main, before.tracking.main); assert.equal(Object.hasOwn(sim.state.commits, remote), false);
  assert.equal(sim.execute('git checkout ' + remote).ok, false); run(sim, 'git fetch');
  assert.equal(sim.state.tracking.main, remote); assert.equal(sim.headId(), before.branches.main); assert.deepEqual(sim.state.work, before.work);
});

for (const rebase of [false, true]) test('非快进推送拒绝，pull ' + (rebase ? '--rebase' : '--no-rebase') + ' 整合后可推送', () => {
  const sim = new Simulator('remote'); assert.equal(sim.execute('git push').ok, false);
  run(sim, 'git pull ' + (rebase ? '--rebase' : '--no-rebase') + ' origin main'); run(sim, 'git push');
  assert.equal(sim.state.remote.branches.main, sim.headId()); assert.equal(sim.state.tracking.main, sim.headId());
});

test('新分支推送并设置上游，未配置上游时拒绝隐式 push', () => {
  const sim = new Simulator(); run(sim, 'git switch -c feature'); change(sim, 'feature.txt', 'feature\n');
  assert.equal(sim.execute('git push').ok, false); run(sim, 'git push -u origin feature'); assert.equal(sim.state.upstreams.feature, 'feature'); run(sim, 'git push');
});

test('分支删除检查合入关系，log --all 不列出仅远程对象或失去引用的提交', () => {
  const sim = new Simulator('branches'); assert.equal(sim.execute('git branch -d bugFix').ok, false);
  run(sim, 'git merge bugFix'); run(sim, 'git branch -d bugFix'); assert.equal(Object.hasOwn(sim.state.branches, 'bugFix'), false);
  const local = new Simulator('reset'); const old = local.headId(); run(local, 'git reset --hard HEAD~1'); local.simulateRemote();
  const output = run(local, 'git log --all').output; assert.equal(output.includes(old + ' '), false); assert.equal(output.includes(local.state.remote.branches.main + ' '), false);
});

test('文本和路径边界不污染对象原型；六场景均可独立加载', () => {
  const sim = new Simulator();
  for (const path of ['../outside', '/root', '.git/config', '__proto__', 'a/constructor/x', 'a\\b']) assert.throws(() => sim.editFile(path, 'x'));
  assert.throws(() => sim.editFile('big.txt', 'x\n'.repeat(301))); sim.editFile('hello world.txt', '<img src=x onerror=alert(1)>'); run(sim, 'git add "hello world.txt"');
  for (const scene of Object.keys(SCENES)) { sim.loadScene(scene); assert.equal(sim.state.pending, null); assert.ok(sim.state.commits[sim.headId()]); }
});
