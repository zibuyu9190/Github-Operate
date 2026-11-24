const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, RemoteWorkspace } = require('../simulator.js');
const { complete, recommend, usage } = require('../command-assist.js');

const workspace = (sim, branch = 'main') => new RemoteWorkspace(branch, sim.state.remote.commits[sim.state.remote.branches[branch]]);
const run = (sim, draft, command) => {
  const result = draft.execute(sim, command);
  assert.equal(result.ok, true, command + ': ' + result.output);
  return result;
};
const localState = sim => Object.fromEntries(Object.entries(sim.snapshot()).filter(([key]) => !['remote', 'nextId'].includes(key)));

test('辅助仓库仅接受协作者和合并负责人身份', () => {
  const sim = new Simulator(), origin = sim.state.remote, tip = origin.commits[origin.branches.main];
  for (const actor of ['local', 'unknown', '__proto__']) {
    assert.throws(() => new RemoteWorkspace('main', tip, origin, actor), {
      name: 'TypeError', message: '无效的辅助仓库身份。'
    });
  }
  assert.equal(workspace(sim).actor, 'remote');
  const integrator = new RemoteWorkspace('main', tip, origin, 'integrator');
  assert.equal(run(sim, integrator, 'git status').actor, 'integrator');
});

test('协作者选择删除处理冲突时，文件列表和推荐保留路径直到暂存', () => {
  const sim = new Simulator(), draft = workspace(sim);
  const command = command => run(sim, draft, command);
  command('git branch other');
  command('git rm hello.txt'); command('git commit -m "删除问候"');
  command('git switch other');
  draft.editFile('hello.txt', '修改问候\n');
  command('git add hello.txt'); command('git commit -m "修改问候"');
  command('git switch main');
  const local = localState(sim);
  for (const pathspec of ['hello.txt', '.']) {
    assert.equal(command('git merge other').conflict, true);
    draft.deleteFile('hello.txt');
    assert.deepEqual(draft.fileStatus().find(file => file.path === 'hello.txt'),
      { path: 'hello.txt', staged: false, unstaged: false, untracked: false, deleted: true, conflict: true });
    assert.ok(recommend(draft.commandContext(sim)).some(item => item.command === 'git add hello.txt'));
    command('git add ' + pathspec);
    assert.ok(recommend(draft.commandContext(sim)).some(item => item.command === 'git merge --continue'));
    command('git merge --continue');
    assert.equal(Object.hasOwn(draft.base, 'hello.txt'), false);
    assert.deepEqual(localState(sim), local);
    command('git reset --hard HEAD^');
  }
});

test('协作者先 commit 保存到自己的本地，再 push 发布；我的本地暂存、HEAD 和跟踪不变', () => {
  const sim = new Simulator();
  assert.equal(sim.execute('git switch -c dev').ok, true);
  assert.equal(sim.execute('git push -u origin dev').ok, true);
  sim.editFile('hello.txt', '我的暂存版\n'); sim.execute('git add .'); sim.editFile('hello.txt', '我的工作版\n');
  const local = localState(sim), remoteMain = sim.state.remote.branches.main, draft = workspace(sim, 'dev');
  draft.editFile('hello.txt', '协作者暂存版\n'); run(sim, draft, 'git add hello.txt');
  draft.editFile('hello.txt', '协作者工作版\n');
  const result = run(sim, draft, 'git commit -m "协作者修改 dev 问候"');
  assert.equal(result.actor, 'remote'); assert.equal(result.command.name, 'commit');
  assert.deepEqual(localState(sim), local);
  assert.equal(sim.state.remote.branches.main, remoteMain);
  assert.equal(sim.state.remote.branches.dev, remoteMain);
  assert.equal(sim.state.remote.commits[result.commitId], undefined);
  assert.equal(sim.state.commits[result.commitId], undefined);
  assert.equal(draft.commits[result.commitId].tree['hello.txt'], '协作者暂存版\n');
  assert.equal(draft.work['hello.txt'], '协作者工作版\n'); assert.equal(draft.index['hello.txt'], '协作者暂存版\n');
  assert.equal(draft.baseId, result.commitId); assert.deepEqual(result.before.branches, result.after.branches);
  run(sim, draft, 'git push origin dev');
  assert.equal(sim.state.remote.branches.dev, result.commitId);
  assert.equal(sim.state.remote.commits[result.commitId].tree['hello.txt'], '协作者暂存版\n');
  assert.equal(draft.work['hello.txt'], '协作者工作版\n');
  assert.deepEqual(localState(sim), local);
});

test('协作者 status、diff、log、show 使用协作者快照，查看不改变任一方状态', () => {
  const sim = new Simulator(), draft = workspace(sim), base = draft.baseId;
  sim.editFile('private-local.txt', '仅本地\n'); sim.execute('git add .'); sim.execute('git commit -m "仅本地提交"');
  const localId = sim.headId();
  draft.editFile('hello.txt', '协作者已暂存\n'); run(sim, draft, 'git add hello.txt'); draft.editFile('hello.txt', '协作者未暂存\n');
  const before = sim.snapshot(), buffer = structuredClone(draft);
  assert.match(run(sim, draft, 'git status').output, /本地 main[\s\S]*已暂存\s+hello.txt[\s\S]*未暂存\s+hello.txt/);
  assert.match(run(sim, draft, 'git diff').output, /-协作者已暂存[\s\S]*\+协作者未暂存/);
  assert.match(run(sim, draft, 'git diff --cached').output, /\+协作者已暂存/);
  assert.ok(run(sim, draft, 'git log --oneline --graph --all').output.includes(base));
  assert.doesNotMatch(run(sim, draft, 'git log --all').output, /仅本地提交/);
  assert.match(run(sim, draft, 'git show HEAD~1').output, /补充 README 中的提交练习步骤/);
  assert.equal(draft.execute(sim, 'git show ' + localId).ok, false);
  assert.deepEqual(sim.snapshot(), before); assert.deepEqual(structuredClone(draft), buffer);
});

test('协作者 restore 取消暂存或恢复工作区，支持新增、删除和整批失败回滚', () => {
  const sim = new Simulator(), draft = workspace(sim), original = draft.base['hello.txt'];
  draft.editFile('hello.txt', '已暂存\n'); run(sim, draft, 'git add .'); draft.editFile('hello.txt', '未暂存\n');
  run(sim, draft, 'git restore hello.txt'); assert.equal(draft.work['hello.txt'], '已暂存\n');
  run(sim, draft, 'git restore --staged hello.txt'); assert.equal(draft.index['hello.txt'], original); assert.equal(draft.work['hello.txt'], '已暂存\n');
  draft.editFile('新 file.txt', 'new\n'); run(sim, draft, 'git add "新 file.txt"'); run(sim, draft, 'git restore --staged "新 file.txt"');
  assert.equal(draft.commandContext(sim).files.find(file => file.path === '新 file.txt').untracked, true);
  draft.deleteFile('hello.txt'); run(sim, draft, 'git add hello.txt');
  assert.equal(draft.index['hello.txt'], undefined);
  const before = structuredClone(draft);
  assert.equal(draft.execute(sim, 'git restore --staged hello.txt missing.txt').ok, false);
  assert.deepEqual(structuredClone(draft), before);
  run(sim, draft, 'git restore --staged hello.txt'); run(sim, draft, 'git restore hello.txt'); assert.equal(draft.work['hello.txt'], original);
});

test('协作者 commit -am 自动暂存已跟踪文件，未跟踪文件保持未暂存', () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('hello.txt', 'tracked\n'); draft.editFile('new.txt', 'untracked\n');
  run(sim, draft, 'git commit -am "自动暂存协作者文件"');
  assert.equal(draft.base['hello.txt'], 'tracked\n'); assert.equal(draft.base['new.txt'], undefined);
  assert.equal(draft.work['new.txt'], 'untracked\n'); assert.equal(draft.index['new.txt'], undefined);
});

test('协作者空提交、非法语法、未支持命令和过长说明均不改变双方状态', () => {
  const sim = new Simulator(), draft = workspace(sim);
  assert.equal(draft.execute(sim, 'git commit -m "空提交"').ok, false);
  draft.editFile('hello.txt', '尚未提交\n'); run(sim, draft, 'git add .');
  for (const command of ['git add missing.txt', 'git add hello.txt missing.txt', 'git commit', 'git commit --amend --unknown', 'git push origin other', 'git pull origin other', 'git switch missing', 'git reset --unknown', 'git stash --unknown', 'git commit -m "未闭合', 'git add . && git commit -m "组合"', 'git commit -m "' + '长'.repeat(201) + '"']) {
    const before = sim.snapshot(), buffer = structuredClone(draft);
    assert.equal(draft.execute(sim, command).ok, false, command);
    assert.deepEqual(sim.snapshot(), before, command); assert.deepEqual(structuredClone(draft), buffer, command);
  }
});

test('远程先更新时仍能在协作者本地 commit，push 拒绝非快进并保留双方历史', () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('hello.txt', '旧草稿\n'); run(sim, draft, 'git add .'); sim.simulateRemote();
  assert.equal(draft.commandContext(sim).stale, true);
  const tip = sim.state.remote.branches.main;
  const result = run(sim, draft, 'git commit -m "保存我的提交"');
  const before = sim.snapshot(), buffer = structuredClone(draft);
  assert.equal(draft.execute(sim, 'git push').ok, false);
  assert.deepEqual(sim.snapshot(), before); assert.deepEqual(structuredClone(draft), buffer);
  assert.equal(sim.state.remote.branches.main, tip); assert.notEqual(draft.baseId, tip);
  assert.ok(draft.commits[result.commitId]);
  run(sim, draft, 'git status'); assert.deepEqual(sim.snapshot(), before);
});

test('协作者未 push 时 fetch 拉不到新提交；push 后 fetch 只更新引用，pull 才整合文件', () => {
  const sim = new Simulator(), draft = workspace(sim), original = sim.state.work['hello.txt'];
  draft.editFile('hello.txt', '协作者从命令行提交\n'); run(sim, draft, 'git add .');
  const result = run(sim, draft, 'git commit -m "更新协作内容"');
  assert.equal(sim.state.work['hello.txt'], original); assert.notEqual(sim.state.tracking.main, result.commitId);
  assert.equal(sim.execute('git fetch').ok, true); assert.notEqual(sim.state.tracking.main, result.commitId);
  assert.equal(sim.state.commits[result.commitId], undefined);
  run(sim, draft, 'git push');
  assert.equal(sim.execute('git fetch').ok, true); assert.equal(sim.state.tracking.main, result.commitId); assert.equal(sim.state.work['hello.txt'], original);
  assert.equal(sim.execute('git pull').ok, true); assert.equal(sim.state.work['hello.txt'], '协作者从命令行提交\n');
});

test('协作者推荐和补全区分 commit 与 push，使用自己的文件和历史', () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('peer-only.txt', 'peer\n'); sim.editFile('local-only.txt', 'local\n');
  let context = draft.commandContext(sim);
  const choices = input => complete(input, input.length, context);
  assert.ok(choices('git add ').some(item => item.label === 'peer-only.txt'));
  assert.ok(!choices('git add ').some(item => item.label === 'local-only.txt'));
  assert.ok(choices('git pu').some(item => item.label === 'push')); assert.ok(choices('git switch ').some(item => item.label === 'main'));
  assert.ok(choices('git commit --').some(item => item.label === '--amend'));
  assert.ok(choices('git commit --amend ').some(item => item.label === '--no-edit'));
  assert.match(usage('git commit', context), /协作者本地.*git push/);
  assert.ok(recommend(context).some(item => item.command === 'git add peer-only.txt'));
  assert.ok(recommend(context).some(item => item.command.startsWith('git stash push')));
  run(sim, draft, 'git add .'); context = draft.commandContext(sim);
  assert.ok(recommend(context).some(item => item.command.startsWith('git commit')));
  sim.simulateRemote(); context = draft.commandContext(sim);
  assert.ok(recommend(context).some(item => item.command.startsWith('git commit')));
  run(sim, draft, 'git commit -m "协作内容"'); context = draft.commandContext(sim);
  assert.ok(recommend(context).some(item => item.command.startsWith('git fetch')));
  run(sim, draft, 'git fetch'); context = draft.commandContext(sim);
  assert.ok(recommend(context).some(item => item.command.startsWith('git pull')));
  assert.ok(!recommend(context).some(item => item.command === 'git push'));
});

test('连续私有提交与两方交替提交使用唯一编号，一次 push 发布整条父链且不上传工作区', () => {
  const sim = new Simulator(), draft = workspace(sim), base = draft.baseId;
  draft.editFile('peer.txt', 'one\n'); run(sim, draft, 'git add .'); const first = run(sim, draft, 'git commit -m "协作一"').commitId;
  sim.editFile('local.txt', 'local\n'); sim.execute('git add .'); sim.execute('git commit -m "本地一"');
  const local = sim.headId(); assert.notEqual(local, first);
  draft.editFile('peer.txt', 'two\n'); run(sim, draft, 'git add .'); const second = run(sim, draft, 'git commit -m "协作二"').commitId;
  assert.notEqual(second, local); assert.deepEqual(draft.commits[second].parents, [first]); assert.deepEqual(draft.commits[first].parents, [base]);
  assert.equal(sim.state.remote.branches.main, base);
  draft.editFile('peer.txt', 'not committed\n');
  run(sim, draft, 'git push -u origin main');
  assert.ok(sim.state.remote.commits[first]); assert.equal(sim.state.remote.branches.main, second);
  assert.equal(sim.state.remote.commits[second].tree['peer.txt'], 'two\n');
  assert.equal(sim.headId(), local); assert.equal(sim.state.commits[first], undefined);
  assert.equal(draft.commandContext(sim).ahead, 0);
  assert.deepEqual(run(sim, draft, 'git push').after, sim.snapshot());
});

for (const mode of ['--no-rebase', '--rebase']) test('协作者 fetch 不移动 HEAD，pull ' + mode + ' 整合分叉后可以 push', () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('peer.txt', 'peer\n'); run(sim, draft, 'git add .'); const own = run(sim, draft, 'git commit -m "协作者新增文件"').commitId;
  sim.simulateRemote(); const remote = sim.state.remote.branches.main;
  assert.equal(draft.execute(sim, 'git show ' + remote).ok, false);
  run(sim, draft, 'git fetch origin'); assert.equal(draft.baseId, own); assert.equal(draft.tracking.main, remote);
  run(sim, draft, 'git pull ' + mode);
  const integrated = draft.commits[draft.baseId];
  assert.equal(integrated.parents.length, mode === '--no-rebase' ? 2 : 1);
  assert.ok(integrated.tree['team.txt']); assert.equal(integrated.tree['peer.txt'], 'peer\n');
  assert.equal(sim.state.remote.branches.main, remote);
  run(sim, draft, 'git push'); assert.equal(sim.state.remote.branches.main, integrated.id);
});

for (const actor of ['我的本地', '协作者']) test(actor + '的 pull 只保留已成功执行的 fetch，拒绝整合时不改本地快照', () => {
  const sim = new Simulator(), draft = actor === '协作者' ? workspace(sim) : null;
  const repo = draft || sim;
  const execute = command => draft ? draft.execute(sim, command) : sim.execute(command);
  const state = () => draft ? draft.commandContext(sim).state : sim.snapshot();
  const runCommand = command => assert.equal(execute(command).ok, true, command);
  runCommand('git switch -c side');
  repo.editFile('hello.txt', '本地修改\n'); runCommand('git add hello.txt'); runCommand('git commit -m "侧枝"');
  runCommand('git switch main'); runCommand('git merge --no-ff side');
  sim.simulateRemote();
  const old = state(), shared = sim.snapshot(), remoteTip = old.remote.branches.main;
  repo.editFile('hello.txt', '未暂存改动\n');
  const dirty = state();
  const rejected = execute('git pull --rebase');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.fetchCompleted, undefined);
  assert.deepEqual(state(), dirty);
  repo.editFile('hello.txt', old.work['hello.txt']);
  const fetchedState = { ...old, tracking: old.remote.branches, commits: { ...old.commits, ...old.remote.commits } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = execute('git pull --rebase');
    assert.equal(failed.ok, false);
    assert.equal(failed.fetchCompleted, true);
    assert.match(failed.output, /不支持重放合并提交/);
    assert.match(failed.explanation, /fetch 已完成/);
    assert.equal((failed.graphAfter || failed.after).tracking.main, remoteTip);
    assert.deepEqual(state(), fetchedState);
    if (draft) assert.deepEqual(sim.snapshot(), shared);
  }
});

for (const mode of ['--no-rebase', '--rebase']) for (const abort of [false, true]) test('协作者 pull ' + mode + ' 冲突可编辑、add、继续或中止，abort=' + abort, () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('hello.txt', '协作者\n'); run(sim, draft, 'git add .'); const own = run(sim, draft, 'git commit -m "协作者修改"').commitId;
  sim.editFile('hello.txt', '我的本地\n'); sim.execute('git add .'); sim.execute('git commit -m "本地修改"'); sim.execute('git push');
  const shared = sim.snapshot(), result = run(sim, draft, 'git pull ' + mode); assert.equal(result.conflict, true);
  const operation = mode === '--rebase' ? 'rebase' : 'merge';
  assert.match(draft.work['hello.txt'], /<<<<<<< HEAD/); assert.equal(draft.execute(sim, 'git push').ok, false);
  if (abort) { run(sim, draft, 'git ' + operation + ' --abort'); assert.equal(draft.baseId, own); assert.equal(draft.work['hello.txt'], '协作者\n'); }
  else { draft.editFile('hello.txt', '整合结果\n'); run(sim, draft, 'git add hello.txt'); run(sim, draft, 'git ' + operation + ' --continue'); run(sim, draft, 'git push'); assert.equal(sim.state.remote.commits[draft.baseId].tree['hello.txt'], '整合结果\n'); }
  assert.equal(draft.tracking.main, sim.state.remote.branches.main);
  assert.deepEqual(localState(sim), Object.fromEntries(Object.entries(shared).filter(([key]) => !['remote', 'nextId'].includes(key))));
});
