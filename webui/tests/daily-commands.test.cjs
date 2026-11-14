const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator } = require('../simulator.js');
const { parse } = require('../commands.js');
const { complete, recommend } = require('../command-assist.js');
const run = (sim, command) => {
  const result = sim.execute(command);
  assert.equal(result.ok, true, command + ': ' + result.output);
  return result;
};
const commit = (sim, path, text) => {
  sim.editFile(path, text); run(sim, 'git add .'); run(sim, 'git commit -m "分支修改"');
};
const context = sim => ({ state: sim.state, files: sim.fileStatus(), scene: sim.scene });

test('新增命令拒绝未支持选项与不完整参数，语法错误保持全部状态', () => {
  const sim = new Simulator();
  for (const command of ['git restore', 'git restore --staged', 'git restore --worktree hello.txt', 'git stash push -m', 'git stash push -m ""', 'git stash push -u -u', 'git stash pop --index', 'git stash pop stash@{-1}', 'git stash --continue', 'git show --stat', 'git remote add origin url', 'git branch -a -a']) {
    const before = sim.snapshot(); assert.throws(() => parse(command), command);
    assert.equal(sim.execute(command).ok, false); assert.deepEqual(sim.snapshot(), before);
  }
});

test('restore 区分 HEAD、暂存区和工作区，新增/删除及多文件失败可回滚', () => {
  const sim = new Simulator(), original = sim.headTree()['hello.txt'], head = sim.headId();
  sim.editFile('hello.txt', '暂存版\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', '工作版\n');
  run(sim, 'git restore hello.txt'); assert.equal(sim.state.work['hello.txt'], '暂存版\n');
  sim.editFile('hello.txt', '工作版\n'); run(sim, 'git restore --staged hello.txt');
  assert.equal(sim.state.index['hello.txt'], original); assert.equal(sim.state.work['hello.txt'], '工作版\n');
  sim.editFile('新 file.txt', '新文件\n'); run(sim, 'git add "新 file.txt"'); run(sim, 'git restore --staged "新 file.txt"');
  assert.equal(sim.fileStatus().find(f => f.path === '新 file.txt').untracked, true);
  const before = sim.snapshot(); assert.equal(sim.execute('git restore hello.txt missing.txt').ok, false); assert.deepEqual(sim.snapshot(), before);
  assert.equal(sim.execute('git restore "新 file.txt"').ok, false);
  sim.deleteFile('hello.txt'); run(sim, 'git restore hello.txt'); assert.equal(sim.state.work['hello.txt'], original);
  sim.deleteFile('hello.txt'); run(sim, 'git add hello.txt'); assert.equal(sim.execute('git restore hello.txt').ok, false);
  run(sim, 'git restore --staged .'); run(sim, 'git restore .');
  assert.equal(sim.headId(), head); assert.equal(sim.state.work['新 file.txt'], '新文件\n'); assert.equal(sim.state.work['hello.txt'], original);
});

test('stash push 保存独立快照，默认保留未跟踪文件，pop 不恢复原暂存划分', () => {
  const sim = new Simulator(), head = sim.headId();
  sim.editFile('hello.txt', '暂存版\n'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt', '工作版\n');
  sim.editFile('new.txt', '未跟踪\n'); run(sim, 'git stash push -m "第一次"');
  assert.equal(sim.state.work['new.txt'], '未跟踪\n'); assert.equal(sim.state.index['hello.txt'], sim.headTree()['hello.txt']);
  sim.editFile('README.md', '另一份\n'); run(sim, 'git stash push -u -m "第二次"');
  assert.equal(sim.state.work['new.txt'], undefined); assert.equal(sim.state.stashes.length, 2);
  assert.match(run(sim, 'git stash list').output, /stash@\{0\}.*第二次[\s\S]*stash@\{1\}.*第一次/);
  run(sim, 'git stash pop'); assert.equal(sim.state.work['README.md'], '另一份\n'); assert.equal(sim.state.work['new.txt'], '未跟踪\n');
  run(sim, 'git restore README.md'); run(sim, 'git stash pop');
  assert.equal(sim.state.work['hello.txt'], '工作版\n'); assert.equal(sim.state.index['hello.txt'], sim.headTree()['hello.txt']);
  assert.equal(sim.headId(), head); assert.equal(Object.keys(sim.state.commits).length, 1); assert.equal(sim.state.stashes.length, 0);
  assert.equal(sim.execute('git stash pop').ok, false);
});

test('stash 包含已暂存的新文件与删除，空保存不产生记录', () => {
  const sim = new Simulator(); run(sim, 'git stash'); assert.equal(sim.state.stashes.length, 0);
  sim.editFile('new.txt', 'new\n'); run(sim, 'git stash push'); assert.equal(sim.state.stashes.length, 0);
  run(sim, 'git add new.txt'); sim.deleteFile('hello.txt'); run(sim, 'git stash push');
  run(sim, 'git stash pop'); assert.equal(sim.state.index['new.txt'], 'new\n'); assert.equal(sim.state.work['hello.txt'], undefined);
  assert.equal(sim.state.index['hello.txt'], sim.headTree()['hello.txt']);
});

test('stash pop 可以跨分支三方合并，冲突记录保留，解决后不需要 continue', () => {
  const sim = new Simulator(); run(sim, 'git branch feature');
  sim.editFile('hello.txt', 'stash 修改\n'); run(sim, 'git stash push -m "跨分支"');
  run(sim, 'git switch feature'); commit(sim, 'hello.txt', 'feature 修改\n');
  const head = sim.headId(); assert.equal(run(sim, 'git stash pop').conflict, true);
  assert.equal(sim.state.stashes.length, 1); assert.equal(sim.headId(), head);
  assert.match(sim.state.work['hello.txt'], /<<<<<<< HEAD/);
  const suggestions = recommend(context(sim)).map(x => x.command);
  assert.ok(!suggestions.some(x => /--continue|--abort/.test(x)));
  assert.equal(sim.execute('git stash --continue').ok, false);
  sim.editFile('hello.txt', '解决结果\n'); run(sim, 'git add hello.txt'); assert.equal(sim.state.pending, null);
  run(sim, 'git commit -m "解决 stash 冲突"'); assert.deepEqual(sim.state.commits[sim.headId()].parents, [head]);
  assert.equal(sim.state.stashes.length, 1);
});

test('stash pop 拒绝覆盖未跟踪文件、目录和未提交修改，失败保留完整状态', () => {
  for (const blocker of ['note.txt', 'note.txt/child.txt', 'hello.txt']) {
    const sim = new Simulator(); sim.editFile('note.txt', 'saved\n'); sim.editFile('hello.txt', 'saved\n'); run(sim, 'git stash push -u');
    sim.editFile(blocker, '保留\n'); const before = sim.snapshot();
    assert.equal(sim.execute('git stash pop').ok, false); assert.deepEqual(sim.snapshot(), before);
  }
});

test('stash 冲突可 reset --hard 丢弃，记录保留；场景重置清空 stash', () => {
  const sim = new Simulator(); sim.editFile('hello.txt', 'stash\n'); run(sim, 'git stash push'); commit(sim, 'hello.txt', 'other\n');
  run(sim, 'git stash pop'); run(sim, 'git reset --hard');
  assert.equal(sim.state.pending, null); assert.equal(sim.isClean(), true); assert.equal(sim.state.stashes.length, 1);
  sim.loadScene('basic'); assert.equal(sim.state.stashes.length, 0);
});

test('show、branch 与 remote 只读查询，不提前读取虚拟远程的新引用', () => {
  const sim = new Simulator(); commit(sim, 'hello.txt', '<img src=x onerror=alert(1)>\n'); sim.simulateRemote();
  const before = sim.snapshot();
  assert.match(run(sim, 'git show HEAD').output, /\+<img src=x onerror=alert\(1\)>/);
  assert.match(run(sim, 'git show HEAD~1').output, /初始化练习仓库/);
  assert.match(run(sim, 'git branch -a').output, /remotes\/origin\/main → C0/);
  assert.match(run(sim, 'git branch -vv').output, /origin\/main：领先 1，落后 0/);
  assert.match(run(sim, 'git remote -v').output, /无真实地址/); assert.deepEqual(sim.snapshot(), before);
  run(sim, 'git fetch'); assert.match(run(sim, 'git branch -a -vv').output, /领先 1，落后 1/);
});

test('新命令自动补全来自当前状态，推荐与冲突处理方式一致', () => {
  const sim = new Simulator(); sim.editFile('new.txt', 'new\n'); sim.editFile('hello.txt', 'work\n'); run(sim, 'git add hello.txt');
  const choices = text => complete(text, text.length, context(sim));
  assert.equal(choices('git rest')[0].value, 'git restore ');
  assert.ok(choices('git restore ').some(x => x.label === 'hello.txt')); assert.ok(!choices('git restore ').some(x => x.label === 'new.txt'));
  assert.equal(choices('git stash pu')[0].value, 'git stash push ');
  assert.equal(choices('git stash push -m ')[0].value, 'git stash push -m ""');
  assert.ok(choices('git stash push -u --').length === 0);
  assert.equal(choices('git branch -v')[0].label, '-vv'); assert.equal(choices('git remote -')[0].label, '-v');
  assert.equal(choices('git branch -a -v')[0].label, '-vv');
  assert.ok(choices('git show H').some(x => x.label === 'HEAD'));
  assert.ok(recommend(context(sim)).some(x => x.command.startsWith('git stash push')));
  run(sim, 'git stash push -u'); assert.ok(recommend(context(sim)).some(x => x.command === 'git stash pop'));
});

test('恢复操作拒绝文件/目录冲突，失败保持原快照', () => {
  const sim = new Simulator(); sim.deleteFile('hello.txt'); run(sim, 'git add hello.txt'); sim.editFile('hello.txt/child.txt', '保留\n');
  run(sim, 'git add hello.txt/child.txt');
  let before = sim.snapshot(); assert.equal(sim.execute('git restore --staged hello.txt').ok, false); assert.deepEqual(sim.snapshot(), before);
  run(sim, 'git restore --staged hello.txt/child.txt');
  before = sim.snapshot(); assert.equal(sim.execute('git stash push').ok, false); assert.deepEqual(sim.snapshot(), before);
  run(sim, 'git restore --staged hello.txt');
  before = sim.snapshot(); assert.equal(sim.execute('git restore hello.txt').ok, false); assert.deepEqual(sim.snapshot(), before);
  run(sim, 'git stash push -u'); assert.equal(sim.state.stashes.length, 1); assert.equal(sim.state.work['hello.txt'], sim.headTree()['hello.txt']);
});
