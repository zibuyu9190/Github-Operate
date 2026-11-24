const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, RemoteWorkspace } = require('../simulator.js');

function run(sim, command) { const result = sim.execute(command); assert.equal(result.ok, true, result.output); return result; }
function workspace(sim, branch = 'main') { return new RemoteWorkspace(branch, sim.state.remote.commits[sim.state.remote.branches[branch]]); }
function stage(sim, draft, path = '.') { const result = draft.execute(sim, 'git add ' + path); assert.equal(result.ok, true, result.output); return result; }
function submit(sim, draft, message = '协作者自由编辑文件') {
  const result = draft.execute(sim, 'git commit -m ' + JSON.stringify(message));
  if (result.ok) assert.equal(draft.execute(sim, 'git push').ok, true);
  return result;
}

test('协作者草稿独立维护工作区与暂存区，提交只保存暂存版本并保留后续编辑', () => {
  const sim = new Simulator(), draft = workspace(sim), original = sim.snapshot();
  draft.editFile('hello.txt', '协作者暂存版本\r\n'); stage(sim, draft, 'hello.txt'); draft.editFile('hello.txt', '协作者后续草稿\n');
  assert.deepEqual(sim.snapshot(), original);
  const parent = draft.baseId, result = submit(sim, draft); assert.equal(result.ok, true);
  const commit = sim.state.remote.commits[result.commitId];
  assert.equal(commit.tree['hello.txt'], '协作者暂存版本\n'); assert.deepEqual(commit.parents, [parent]);
  assert.equal(draft.work['hello.txt'], '协作者后续草稿\n');
  assert.equal(draft.index['hello.txt'], '协作者暂存版本\n'); assert.equal(draft.fileStatus().find(file => file.path === 'hello.txt').unstaged, true);
  for (const key of Object.keys(original).filter(key => !['remote', 'nextId'].includes(key))) assert.deepEqual(sim.state[key], original[key], key);
  assert.equal(sim.state.remote.commits[original.remote.branches.main].tree['hello.txt'], original.work['hello.txt']);
});

test('协作者新增、修改、删除多个文件及空文件，diff 与快照一致', () => {
  const sim = new Simulator(), draft = workspace(sim);
  draft.editFile('hello.txt', '<img src=x onerror=alert(1)>\n'); draft.deleteFile('README.md');
  draft.editFile('src/新增记录.txt', '中文内容\n'); draft.editFile('empty.txt', ''); stage(sim, draft);
  assert.equal(draft.fileStatus().find(file => file.path === 'README.md').deleted, true);
  const result = submit(sim, draft, '修改问候、删除说明并新增记录'); assert.equal(result.ok, true);
  const commit = sim.state.remote.commits[result.commitId];
  assert.equal(commit.tree['README.md'], undefined); assert.equal(commit.tree['empty.txt'], '');
  assert.equal(commit.tree['src/新增记录.txt'], '中文内容\n'); assert.equal(commit.tree['hello.txt'], '<img src=x onerror=alert(1)>\n');
  assert.match(draft.execute(sim, 'git show HEAD').output, /\+<img/); assert.match(draft.execute(sim, 'git show HEAD').output, /--- README.md/);
  draft.work['hello.txt'] = '再次编辑'; assert.equal(commit.tree['hello.txt'], '<img src=x onerror=alert(1)>\n');
});

test('main 与 dev 的协作者文件、暂存和基点彼此隔离，提交只推进目标远程分支', () => {
  const sim = new Simulator(); run(sim, 'git switch -c dev'); run(sim, 'git push -u origin dev');
  const mainDraft = workspace(sim), devDraft = workspace(sim, 'dev'), originalMain = sim.state.remote.branches.main;
  mainDraft.editFile('hello.txt', 'main 草稿\n'); devDraft.editFile('hello.txt', 'dev 暂存\n'); stage(sim, devDraft);
  const result = submit(sim, devDraft); assert.equal(result.ok, true); assert.equal(result.branch, 'dev');
  assert.equal(sim.state.remote.branches.main, originalMain); assert.equal(mainDraft.work['hello.txt'], 'main 草稿\n');
  assert.equal(mainDraft.index['hello.txt'], sim.headTree()['hello.txt']); assert.equal(sim.state.head.branch, 'dev');
  assert.equal(sim.state.tracking.dev, originalMain);
});

test('协作者编辑、提交与推送校验输入与过期基点，失败不改变双方状态', () => {
  const sim = new Simulator(), draft = workspace(sim);
  for (const [path, text] of [['../bad.txt', 'x'], ['a.txt/nested.txt', 'b'], ['bad.txt', '\0'], ['bad.txt', 'a'.repeat(20001)], ['bad.txt', 'a\n'.repeat(301)]]) {
    if (path === 'a.txt/nested.txt') draft.editFile('a.txt', 'a');
    const before = sim.snapshot(), beforeDraft = structuredClone(draft);
    assert.throws(() => draft.editFile(path, text));
    assert.deepEqual(sim.snapshot(), before); assert.deepEqual(structuredClone(draft), beforeDraft);
  }
  draft.editFile('hello.txt', '有效改动\n'); stage(sim, draft);
  for (const command of ['git commit -m ""', 'git commit -m "   "', 'git commit -m "' + 'a'.repeat(201) + '"']) {
    const before = sim.snapshot(), beforeDraft = structuredClone(draft);
    assert.equal(draft.execute(sim, command).ok, false);
    assert.deepEqual(sim.snapshot(), before); assert.deepEqual(structuredClone(draft), beforeDraft);
  }
  const committed = draft.execute(sim, 'git commit -m "有效说明"'); assert.equal(committed.ok, true);
  const beforeMissing = sim.snapshot();
  assert.equal(draft.execute(sim, 'git push origin missing').ok, false);
  assert.deepEqual(sim.snapshot(), beforeMissing);
  sim.simulateRemote('main'); const advanced = sim.snapshot();
  assert.equal(draft.execute(sim, 'git push').ok, false);
  assert.deepEqual(sim.snapshot(), advanced);
  assert.equal(draft.work['hello.txt'], '有效改动\n');
});

test('非法编辑和缺省路径暂存失败保持草稿，删除和重新创建可以分阶段暂存', () => {
  const sim = new Simulator(), draft = workspace(sim);
  for (const [path, text] of [['../bad', 'x'], ['hello.txt/nested', 'x'], ['bad', '\0'], ['bad', 'x\n'.repeat(301)]]) {
    const before = structuredClone(draft); assert.throws(() => draft.editFile(path, text)); assert.deepEqual(structuredClone(draft), before);
  }
  draft.editFile('hello.txt', '准备暂存\n'); const before = structuredClone(draft);
  assert.equal(draft.execute(sim, 'git add missing').ok, false); assert.deepEqual(structuredClone(draft), before);
  draft.deleteFile('hello.txt'); stage(sim, draft, 'hello.txt'); assert.equal(draft.index['hello.txt'], undefined);
  draft.editFile('hello.txt', '恢复文件\n'); assert.equal(draft.index['hello.txt'], undefined);
  stage(sim, draft, 'hello.txt'); assert.equal(draft.index['hello.txt'], '恢复文件\n');
});

test('fetch 只下载协作者自定义内容，pull 后才更新本地文件', () => {
  const sim = new Simulator(), draft = workspace(sim), original = sim.snapshot();
  draft.editFile('hello.txt', '协作者自由修改的问候\n'); stage(sim, draft);
  const result = submit(sim, draft); assert.equal(result.ok, true);
  run(sim, 'git fetch'); assert.equal(sim.state.tracking.main, result.commitId); assert.deepEqual(sim.state.work, original.work);
  run(sim, 'git pull'); assert.equal(sim.state.work['hello.txt'], '协作者自由修改的问候\n'); assert.equal(sim.headId(), result.commitId);
});

test('本地和协作者修改同一行会产生真实三方冲突，可以中止或解决继续', () => {
  for (const abort of [false, true]) {
    const sim = new Simulator(), draft = workspace(sim);
    sim.editFile('hello.txt', sim.state.work['hello.txt'].replace('你好，Git！', '本地问候')); run(sim, 'git add .'); run(sim, 'git commit -m "本地改问候"');
    draft.editFile('hello.txt', draft.work['hello.txt'].replace('你好，Git！', '协作者问候')); stage(sim, draft); assert.equal(submit(sim, draft).ok, true);
    const before = sim.snapshot(); assert.equal(run(sim, 'git pull').conflict, true);
    assert.match(sim.state.work['hello.txt'], /<<<<<<< HEAD/); assert.match(sim.state.work['hello.txt'], /协作者问候/);
    if (abort) { run(sim, 'git merge --abort'); assert.deepEqual(sim.state.work, before.work); }
    else { sim.editFile('hello.txt', '统一问候\n'); run(sim, 'git add hello.txt'); run(sim, 'git merge --continue'); assert.equal(sim.headTree()['hello.txt'], '统一问候\n'); }
  }
});
