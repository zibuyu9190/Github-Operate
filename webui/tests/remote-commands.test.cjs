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

test('协作者命令提交只推进所选远程分支，本地暂存、HEAD 和跟踪引用保持原样', () => {
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
  assert.equal(sim.state.remote.branches.dev, result.commitId);
  assert.equal(sim.state.remote.commits[result.commitId].tree['hello.txt'], '协作者暂存版\n');
  assert.equal(draft.work['hello.txt'], '协作者工作版\n'); assert.equal(draft.index['hello.txt'], '协作者暂存版\n');
  assert.equal(draft.baseId, result.commitId); assert.deepEqual(result.before.branches, result.after.branches);
});

test('协作者 status、diff、log、show 使用协作者快照，查看不改变任一方状态', () => {
  const sim = new Simulator(), draft = workspace(sim), base = draft.baseId;
  sim.editFile('private-local.txt', '仅本地\n'); sim.execute('git add .'); sim.execute('git commit -m "仅本地提交"');
  const localId = sim.headId();
  draft.editFile('hello.txt', '协作者已暂存\n'); run(sim, draft, 'git add hello.txt'); draft.editFile('hello.txt', '协作者未暂存\n');
  const before = sim.snapshot(), buffer = structuredClone(draft);
  assert.match(run(sim, draft, 'git status').output, /远程 main[\s\S]*已暂存\s+hello.txt[\s\S]*未暂存\s+hello.txt/);
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
  for (const command of ['git add missing.txt', 'git add hello.txt missing.txt', 'git commit', 'git commit --amend -m "修改历史"', 'git push', 'git pull', 'git switch main', 'git reset --hard', 'git stash', 'git commit -m "未闭合', 'git add . && git commit -m "组合"', 'git commit -m "' + '长'.repeat(201) + '"']) {
    const before = sim.snapshot(), buffer = structuredClone(draft);
    assert.equal(draft.execute(sim, command).ok, false, command);
    assert.deepEqual(sim.snapshot(), before, command); assert.deepEqual(structuredClone(draft), buffer, command);
  }
});

test('协作者过期草稿可查看，但拒绝覆盖远程更新，失败保留已暂存内容', () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('hello.txt', '旧草稿\n'); run(sim, draft, 'git add .'); sim.simulateRemote();
  const before = sim.snapshot(), buffer = structuredClone(draft);
  assert.equal(draft.commandContext(sim).stale, true);
  assert.equal(draft.execute(sim, 'git commit -m "不能覆盖"').ok, false);
  assert.deepEqual(sim.snapshot(), before); assert.deepEqual(structuredClone(draft), buffer);
  run(sim, draft, 'git status'); assert.deepEqual(sim.snapshot(), before);
});

test('协作者命令提交后，本地 fetch 只更新引用，pull 再整合文件', () => {
  const sim = new Simulator(), draft = workspace(sim), original = sim.state.work['hello.txt'];
  draft.editFile('hello.txt', '协作者从命令行提交\n'); run(sim, draft, 'git add .');
  const result = run(sim, draft, 'git commit -m "更新协作内容"');
  assert.equal(sim.state.work['hello.txt'], original); assert.notEqual(sim.state.tracking.main, result.commitId);
  assert.equal(sim.execute('git fetch').ok, true); assert.equal(sim.state.tracking.main, result.commitId); assert.equal(sim.state.work['hello.txt'], original);
  assert.equal(sim.execute('git pull').ok, true); assert.equal(sim.state.work['hello.txt'], '协作者从命令行提交\n');
});

test('协作者推荐与补全使用所选分支的文件和可用命令，提示直接提交语义', () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('peer-only.txt', 'peer\n'); sim.editFile('local-only.txt', 'local\n');
  let context = draft.commandContext(sim);
  const choices = input => complete(input, input.length, context);
  assert.ok(choices('git add ').some(item => item.label === 'peer-only.txt'));
  assert.ok(!choices('git add ').some(item => item.label === 'local-only.txt'));
  assert.deepEqual(choices('git pu'), []); assert.deepEqual(choices('git switch '), []);
  assert.ok(!choices('git commit --').some(item => item.label === '--amend'));
  assert.deepEqual(choices('git commit --amend '), []);
  assert.match(usage('git commit', context), /直接提交到虚拟远程/);
  assert.ok(recommend(context).some(item => item.command === 'git add peer-only.txt'));
  assert.ok(!recommend(context).some(item => /push|pull|stash|switch/.test(item.command)));
  run(sim, draft, 'git add .'); context = draft.commandContext(sim);
  assert.ok(recommend(context).some(item => item.command.startsWith('git commit')));
  sim.simulateRemote(); context = draft.commandContext(sim);
  assert.ok(!recommend(context).some(item => item.command.startsWith('git commit')));
});
