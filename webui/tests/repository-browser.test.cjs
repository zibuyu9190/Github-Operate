const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, RemoteWorkspace, edits } = require('../simulator.js');
const { Model, View, listEntries, fileStats, latestPathCommit, commitAge } = require('../graph-viewer.js').RepositoryBrowser;

function run(sim, command) { const result = sim.execute(command); assert.equal(result.ok, true, result.output); return result; }
function commit(sim, file, content) { sim.editFile(file, content); run(sim, 'git add .'); run(sim, 'git commit -m "更新 ' + file + '"'); }

test('目录按精确路径分段并优先列出文件夹，支持中文、空格和对象原型同名文件', () => {
  const tree = { 'src/deep/hello.txt': '你好\n', 'src/a.txt': 'a', 'src-old/b.txt': 'b', 'toString': '普通文本', '空 白.txt': '' };
  assert.deepEqual(listEntries(tree).map(entry => [entry.name, entry.directory]), [['src', true], ['src-old', true], ['空 白.txt', false], ['toString', false]].sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0], 'zh-CN')));
  assert.deepEqual(listEntries(tree, 'src').map(entry => entry.path), ['src/deep', 'src/a.txt']);
  assert.deepEqual(listEntries(tree, 'src/deep').map(entry => entry.name), ['hello.txt']);
  assert.equal(listEntries(tree).find(entry => entry.name === 'toString').bytes, 12);
});

test('完整文本行数与 UTF-8 字节数准确，包括空文件、空行和末尾换行', () => {
  assert.deepEqual(fileStats(''), { lines: 0, bytes: 0, rows: [] });
  assert.deepEqual(fileStats('你好\n\n第二行'), { lines: 3, bytes: 17, rows: ['你好', '', '第二行'] });
  assert.deepEqual(fileStats('\n'), { lines: 1, bytes: 1, rows: [''] });
  assert.equal(fileStats('a\n').lines, 1);
});

test('默认展示远程实际提交，本地未提交编辑、暂存和协作者提交不会混入其他来源', () => {
  const sim = new Simulator(), model = new Model(), original = sim.headTree()['hello.txt'];
  sim.editFile('hello.txt', '本地未提交\n'); run(sim, 'git add .');
  assert.equal(model.read(sim.state).tree['hello.txt'], original);
  model.selectSource('local', sim.state); assert.equal(model.read(sim.state).tree['hello.txt'], original);
  const remote = sim.commitRemote('main', { baseId: sim.state.remote.branches.main, tree: { ...sim.headTree(), 'hello.txt': '协作者提交\n' }, message: '协作者更新' });
  assert.equal(remote.ok, true);
  model.selectSource('remote', sim.state); assert.equal(model.read(sim.state).tree['hello.txt'], '协作者提交\n');
  model.selectSource('tracking', sim.state); assert.equal(model.read(sim.state).tree['hello.txt'], original);
  run(sim, 'git fetch'); assert.equal(model.read(sim.state).tree['hello.txt'], '协作者提交\n');
  model.selectSource('local', sim.state); assert.equal(model.read(sim.state).tree['hello.txt'], original);
});

test('本地提交、push、远程协作者、fetch 与 pull 各自更新对应的浏览版本', () => {
  const sim = new Simulator(), model = new Model();
  commit(sim, 'local.txt', '我的提交\n');
  assert.equal(Object.hasOwn(model.read(sim.state).tree, 'local.txt'), false);
  model.selectSource('local', sim.state); assert.equal(model.read(sim.state).tree['local.txt'], '我的提交\n');
  run(sim, 'git push'); model.selectSource('remote', sim.state); assert.equal(model.read(sim.state).tree['local.txt'], '我的提交\n');
  const tip = sim.state.remote.branches.main;
  assert.equal(sim.commitRemote('main', { baseId: tip, tree: { ...sim.state.remote.commits[tip].tree, 'remote.txt': '他人提交\n' }, message: '添加远程文件' }).ok, true);
  model.selectSource('tracking', sim.state); assert.equal(Object.hasOwn(model.read(sim.state).tree, 'remote.txt'), false);
  run(sim, 'git fetch'); assert.equal(model.read(sim.state).tree['remote.txt'], '他人提交\n');
  model.selectSource('local', sim.state); assert.equal(Object.hasOwn(model.read(sim.state).tree, 'remote.txt'), false);
  run(sim, 'git pull'); assert.equal(model.read(sim.state).tree['remote.txt'], '他人提交\n');
});

test('切换浏览来源或分支不会移动 HEAD，查看目录与文件后所有仓库状态保持不变', () => {
  const sim = new Simulator(), model = new Model(); run(sim, 'git switch -c dev');
  commit(sim, 'src/deep/hello.txt', '<script>alert(1)</script>\n'); run(sim, 'git push -u origin dev');
  const before = sim.snapshot();
  model.read(sim.state); model.selectReference('branch:dev', sim.state); model.openPath('src', sim.state); model.openPath('src/deep/hello.txt', sim.state);
  assert.equal(model.read(sim.state).file, 'src/deep/hello.txt');
  model.selectSource('local', sim.state); model.selectReference('branch:main', sim.state);
  assert.equal(model.read(sim.state).file, null); assert.equal(model.directory, '');
  assert.equal(model.openPath('missing/path', sim.state), false);
  assert.throws(() => model.selectReference('branch:missing', sim.state)); assert.throws(() => model.selectSource('missing', sim.state));
  assert.deepEqual(sim.snapshot(), before);
});

test('删除文件后退回最近存在的父目录，分支删除后选择有效分支，不保留旧快照', () => {
  const sim = new Simulator(), model = new Model();
  commit(sim, 'src/deep/item.txt', '内容'); commit(sim, 'src/stay.txt', '保留'); run(sim, 'git push');
  model.read(sim.state); model.openPath('src/deep/item.txt', sim.state);
  run(sim, 'git rm src/deep/item.txt'); run(sim, 'git commit -m "删除嵌套文件"'); run(sim, 'git push');
  const snapshot = model.read(sim.state);
  assert.equal(snapshot.file, null); assert.equal(snapshot.directory, 'src'); assert.match(snapshot.notice, /不存在/);
  run(sim, 'git branch dev'); model.selectSource('local', sim.state); model.selectReference('branch:dev', sim.state);
  run(sim, 'git branch -d dev'); assert.equal(model.read(sim.state).ref.name, 'main');
});

test('分离 HEAD、无远程引用、空树和缺失本地对象均明确展示，不能读取远程对象冒充本地', () => {
  const sim = new Simulator(), model = new Model(); commit(sim, 'later.txt', '后续'); run(sim, 'git switch --detach HEAD~1');
  model.selectSource('local', sim.state); model.selectReference('head:', sim.state);
  assert.equal(model.read(sim.state).commit.id, sim.headId());
  const state = sim.snapshot(); state.remote.branches = {}; model.selectSource('remote', state); assert.equal(model.read(state).commit, null);
  state.remote.branches.main = 'C0'; state.remote.commits.C0.tree = {}; assert.deepEqual(model.read(state).entries, []);
  state.tracking.main = 'C999'; state.remote.commits.C999 = { tree: { 'secret.txt': '远程未下载' } };
  model.selectSource('tracking', state); assert.equal(model.read(state).commit, null); assert.equal(model.read(state).total, 0);
});

/** 小型 DOM 测试仅检查纯文本渲染、导航及事件，原生弹窗与响应式排版另外通过浏览器验证。 */
function fixture(readContext) {
  let document;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.isConnected = true; this.scrollTop = 0; this.value = ''; this.textContent = ''; this.classes = new Set(); this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) }; }
    append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
    before(item) { item.parentElement = this.parentElement; this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, item); }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
    fire(name, values = {}) { for (const handler of this.events[name] || []) handler({ target: this, ...values }); }
    querySelector(tag) { return all(this).find(element => element.tagName === tag); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 610, bottom: 610 }; }
  }
  function all(element) { return [element, ...element.children.flatMap(all)]; }
  const help = new Element('button'), header = new Element('header'), body = new Element('body'), editor = new Element('textarea'); header.append(help); body.append(header, editor);
  document = { createElement: tag => new Element(tag), body, activeElement: editor, getElementById: () => help };
  const sim = new Simulator(); let prepares = 0;
  const previous = global.document; global.document = document;
  let view; try { view = new View(() => readContext ? readContext(sim) : ({ state: sim.state }), () => prepares++); } finally { global.document = previous; }
  const withDocument = action => {
    const previous = global.document, oldSimulator = global.GitSimulator;
    global.document = document; global.GitSimulator = { edits };
    try { return action(); } finally { global.document = previous; global.GitSimulator = oldSimulator; }
  };
  return { sim, view, all: () => all(view.dialog), document, editor, prepares: () => prepares, withDocument };
}

test('仓库弹窗支持纯文本文件与 README 预览、目录导航及关闭恢复焦点，保留全部仓库状态', () => {
  const f = fixture();
  const text = '<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n';
  commit(f.sim, 'src/中文 文件.txt', text); commit(f.sim, 'README.md', text); run(f.sim, 'git push');
  const before = f.sim.snapshot(); f.withDocument(() => {
    f.view.open(); f.view.open(); assert.equal(f.prepares(), 1); assert.equal(f.view.dialog.open, true); assert.equal(f.document.body.classes.has('repository-browser-open'), true);
    assert.ok(f.all().some(element => element.tagName === 'pre' && element.textContent === text));
    const directory = f.all().find(element => element.attributes['aria-label'] === '打开目录 src'); directory.fire('click');
    const file = f.all().find(element => element.attributes['aria-label'] === '查看文件 中文 文件.txt'); file.fire('click');
    assert.deepEqual(f.all().filter(element => element.className === 'repo-line-text').map(element => element.textContent), ['<img src=x onerror=alert(1)>', '', '<script>alert(1)</script>']);
    assert.equal(f.all().filter(element => ['img', 'script'].includes(element.tagName)).length, 0);
    assert.ok(f.all().some(element => element.attributes['aria-current'] === 'page' && element.textContent === '中文 文件.txt'));
    f.view.closeButton.fire('click'); assert.equal(f.document.activeElement, f.editor); assert.equal(f.document.body.classes.has('repository-browser-open'), false);
    f.view.open(); assert.equal(f.view.model.file, 'src/中文 文件.txt');
    f.view.reset(); assert.equal(f.view.model.file, null); assert.equal(f.view.model.source, 'local');
  });
  assert.deepEqual(f.sim.snapshot(), before);
});

test('弹窗选择框按实际来源更新内容，空文件和无分支状态均可见', () => {
  const f = fixture(); commit(f.sim, 'empty.txt', '');
  f.withDocument(() => {
    f.view.open(); f.view.sourceSelect.value = 'local'; f.view.sourceSelect.fire('change');
    const file = f.all().find(element => element.attributes['aria-label'] === '查看文件 empty.txt'); file.fire('click');
    assert.ok(f.all().some(element => element.textContent === '空文件'));
    f.sim.state.remote.branches = {}; f.view.sourceSelect.value = 'remote'; f.view.sourceSelect.fire('change');
    assert.equal(f.view.branchSelect.disabled, true); assert.ok(f.all().some(element => element.textContent.includes('此位置暂无分支')));
    f.view.dialog.fire('click', { clientX: 20, clientY: 20 }); assert.equal(f.view.dialog.open, true);
    f.view.dialog.fire('click', { clientX: 0, clientY: 0 }); assert.equal(f.view.dialog.open, false);
  });
});

test('仓库浏览跟随身份与各自初始分支，隔离未推送提交并分别保留浏览位置', () => {
  let actor = 'local', peer;
  const f = fixture(sim => ({ actor, state: actor === 'remote' ? peer.commandContext(sim).state : sim.state }));
  peer = new RemoteWorkspace('main', f.sim.state.remote.commits[f.sim.state.remote.branches.main], f.sim.state.remote);
  run(f.sim, 'git switch -c mine'); commit(f.sim, 'mine.txt', '我的未推送提交\n');
  const executePeer = command => { const result = peer.execute(f.sim, command); assert.equal(result.ok, true, result.output); };
  executePeer('git switch -c dev'); peer.editFile('peer.txt', '协作者未推送提交\n');
  executePeer('git add .'); executePeer('git commit -m "协作者独立修改"');
  peer.editFile('draft.txt', '协作者未提交草稿'); executePeer('git add draft.txt');
  const mineBefore = f.sim.snapshot(), peerBefore = peer.commandContext(f.sim).state;
  f.withDocument(() => {
    f.view.open();
    assert.equal(f.view.sourceSelect.value, 'local'); assert.equal(f.view.branchSelect.value, 'branch:mine');
    assert.match(f.view.actorBadge.textContent, /我的本地视角/);
    assert.equal(f.view.sourceSelect.children.find(option => option.value === 'local').textContent, '我的本地仓库');
    f.view.navigate('mine.txt'); f.view.closeButton.fire('click');
    actor = 'remote'; f.view.open();
    assert.equal(f.view.sourceSelect.value, 'local'); assert.equal(f.view.branchSelect.value, 'branch:dev');
    assert.match(f.view.actorBadge.textContent, /协作者视角/); assert.match(f.view.hint.textContent, /协作者本地/);
    assert.equal(f.view.sourceSelect.children.find(option => option.value === 'local').textContent, '协作者本地仓库');
    assert.ok(f.all().some(item => item.attributes['aria-label'] === '查看文件 peer.txt'));
    assert.ok(!f.all().some(item => /查看文件 (mine|draft)\.txt/.test(item.attributes['aria-label'] || '')));
    f.view.navigate('peer.txt'); f.view.closeButton.fire('click');
    actor = 'local'; f.view.open();
    assert.equal(f.view.model.file, 'mine.txt'); assert.equal(f.view.branchSelect.value, 'branch:mine');
    assert.ok(f.all().some(item => item.className === 'repo-line-text' && item.textContent === '我的未推送提交'));
    f.view.closeButton.fire('click'); actor = 'remote'; f.view.open();
    assert.equal(f.view.model.file, 'peer.txt'); assert.equal(f.view.branchSelect.value, 'branch:dev');
    assert.ok(f.all().some(item => item.className === 'repo-line-text' && item.textContent === '协作者未推送提交'));
  });
  assert.deepEqual(f.sim.snapshot(), mineBefore); assert.deepEqual(peer.commandContext(f.sim).state, peerBefore);
});

test('浏览共享远程与各自跟踪引用时遵循 push 和 fetch 边界，不暗中同步仓库', () => {
  let actor = 'local', peer;
  const f = fixture(sim => ({ actor, state: actor === 'remote' ? peer.commandContext(sim).state : sim.state }));
  peer = new RemoteWorkspace('main', f.sim.state.remote.commits[f.sim.state.remote.branches.main], f.sim.state.remote);
  const executePeer = command => { const result = peer.execute(f.sim, command); assert.equal(result.ok, true, result.output); };
  const initial = f.sim.headId(); peer.editFile('shared.txt', '共享的新文件\n');
  executePeer('git add .'); executePeer('git commit -m "准备共享文件"');
  f.withDocument(() => {
    actor = 'remote'; f.view.open();
    f.view.sourceSelect.value = 'remote'; f.view.sourceSelect.fire('change');
    assert.ok(!f.all().some(item => item.attributes['aria-label'] === '查看文件 shared.txt'));
    assert.match(f.view.hint.textContent, /push/); f.view.closeButton.fire('click');
    executePeer('git push'); const published = peer.baseId;
    actor = 'local'; f.view.open();
    f.view.sourceSelect.value = 'remote'; f.view.sourceSelect.fire('change');
    assert.equal(f.view.model.read(f.sim.state).commit.id, published);
    assert.ok(f.all().some(item => item.attributes['aria-label'] === '查看文件 shared.txt'));
    f.view.sourceSelect.value = 'tracking'; f.view.sourceSelect.fire('change');
    assert.equal(f.view.model.read(f.sim.state).commit.id, initial); assert.match(f.view.hint.textContent, /我的本地记录/);
    f.view.closeButton.fire('click'); actor = 'remote'; f.view.open();
    assert.equal(f.view.sourceSelect.value, 'remote');
    f.view.sourceSelect.value = 'tracking'; f.view.sourceSelect.fire('change');
    assert.equal(f.view.model.read(peer.commandContext(f.sim).state).commit.id, published);
    assert.match(f.view.hint.textContent, /协作者本地记录/); f.view.closeButton.fire('click');
    actor = 'local'; f.view.open();
    assert.equal(f.view.sourceSelect.value, 'tracking'); assert.equal(f.sim.state.tracking.main, initial);
    f.view.closeButton.fire('click'); run(f.sim, 'git fetch'); f.view.open();
    assert.equal(f.view.model.read(f.sim.state).commit.id, published); assert.equal(f.sim.headId(), initial);
    f.view.sourceSelect.value = 'local'; f.view.sourceSelect.fire('change');
    assert.ok(!f.all().some(item => item.attributes['aria-label'] === '查看文件 shared.txt'));
    f.view.closeButton.fire('click'); run(f.sim, 'git pull --no-rebase'); f.view.open();
    assert.ok(f.all().some(item => item.attributes['aria-label'] === '查看文件 shared.txt'));
  });
});

test('身份浏览支持分离 HEAD，场景重置同时清空双方位置并恢复当前身份本地视图', () => {
  let actor = 'local', peer;
  const f = fixture(sim => ({ actor, state: actor === 'remote' ? peer.commandContext(sim).state : sim.state }));
  const initPeer = () => { peer = new RemoteWorkspace('main', f.sim.state.remote.commits[f.sim.state.remote.branches.main], f.sim.state.remote); };
  initPeer();
  f.withDocument(() => {
    f.view.open(); f.view.navigate('README.md'); f.view.closeButton.fire('click');
    assert.equal(peer.execute(f.sim, 'git checkout HEAD~1').ok, true);
    actor = 'remote'; f.view.open(); assert.equal(f.view.branchSelect.value, 'head:');
    f.view.navigate('hello.txt'); f.view.sourceSelect.value = 'tracking'; f.view.sourceSelect.fire('change');
    f.sim.loadScene('basic'); initPeer(); f.view.reset();
    assert.equal(f.view.model.file, null); assert.equal(f.view.sourceSelect.value, 'local');
    assert.equal(f.view.branchSelect.value, 'branch:main'); assert.match(f.view.actorBadge.textContent, /协作者视角/);
    f.view.closeButton.fire('click'); actor = 'local'; f.view.open();
    assert.equal(f.view.model.file, null); assert.equal(f.view.sourceSelect.value, 'local');
    assert.equal(f.view.branchSelect.value, 'branch:main');
  });
});

test('关闭事件延迟到弹窗重开后派发时，仍锁定背景并保留弹窗内的键盘焦点', () => {
  const f = fixture();
  f.withDocument(() => {
    f.view.open();
    // 模拟原生 close() 先修改 open 属性、稍后再派发事件。
    f.view.dialog.open = false;
    f.document.activeElement = f.view.trigger;
    f.view.open(); f.view.dialog.fire('close');
    assert.equal(f.document.body.classes.has('repository-browser-open'), true);
    assert.equal(f.document.activeElement, f.view.branchSelect);
    f.view.closeButton.fire('click');
    assert.equal(f.document.body.classes.has('repository-browser-open'), false);
    assert.equal(f.document.activeElement, f.view.trigger);
  });
});

test('逐文件提交沿所选分支追溯，文件夹汇总内部变更，不混入其他分支或相邻目录', () => {
  const sim = new Simulator(), model = new Model();
  commit(sim, 'src/a.txt', '第一份\n'); const first = sim.headId();
  commit(sim, 'src/deep/b.txt', '第二份\n'); const second = sim.headId();
  commit(sim, 'src-old/other.txt', '相邻路径\n');
  run(sim, 'git branch dev'); run(sim, 'git switch -c other'); commit(sim, 'src/a.txt', '另一分支\n');
  model.selectSource('local', sim.state); model.selectReference('branch:dev', sim.state);
  let snapshot = model.read(sim.state);
  assert.equal(snapshot.entries.find(entry => entry.path === 'src').lastCommit.id, second);
  assert.equal(snapshot.entries.find(entry => entry.path === 'hello.txt').lastCommit.id, 'C0');
  model.openPath('src', sim.state); snapshot = model.read(sim.state);
  assert.equal(snapshot.entries.find(entry => entry.path === 'src/a.txt').lastCommit.id, first);
  assert.equal(snapshot.entries.find(entry => entry.path === 'src/deep').lastCommit.id, second);
  model.openPath('src/a.txt', sim.state); assert.equal(model.read(sim.state).fileCommit.id, first);
});

test('合并沿内容相同的父提交找到文件来源，文件夹的合并结果和冲突解决归于合并提交', () => {
  const sim = new Simulator();
  run(sim, 'git branch feature'); commit(sim, 'src/local.txt', '本地\n'); const local = sim.headId();
  run(sim, 'git switch feature'); commit(sim, 'src/remote.txt', '分支\n'); const feature = sim.headId();
  run(sim, 'git switch main'); run(sim, 'git merge feature'); const merged = sim.headId();
  assert.equal(latestPathCommit(sim.state.commits, merged, 'src/local.txt').id, local);
  assert.equal(latestPathCommit(sim.state.commits, merged, 'src/remote.txt').id, feature);
  assert.equal(latestPathCommit(sim.state.commits, merged, 'src', true).id, merged);
  assert.equal(latestPathCommit(sim.state.commits, merged, 'hello.txt').id, 'C0');
  const conflict = new Simulator('conflict'); run(conflict, 'git merge bugFix');
  conflict.editFile('hello.txt', '保留双方并调整问候\n'); run(conflict, 'git add hello.txt'); run(conflict, 'git merge --continue');
  assert.equal(latestPathCommit(conflict.state.commits, conflict.headId(), 'hello.txt').id, conflict.headId());
});

test('没有文件变化的 no-ff 合并不覆盖原说明，删除重建、改名和空文件记录真实最近提交', () => {
  const sim = new Simulator(); run(sim, 'git switch -c feature');
  commit(sim, 'empty.txt', ''); const created = sim.headId();
  run(sim, 'git switch main'); run(sim, 'git merge --no-ff feature');
  assert.equal(latestPathCommit(sim.state.commits, sim.headId(), 'empty.txt').id, created);
  run(sim, 'git rm empty.txt'); run(sim, 'git commit -m "删除空文件"');
  commit(sim, 'empty.txt', ''); const recreated = sim.headId();
  assert.equal(latestPathCommit(sim.state.commits, recreated, 'empty.txt').id, recreated);
  run(sim, 'git mv empty.txt renamed.txt'); run(sim, 'git commit -m "重命名空文件"');
  assert.equal(latestPathCommit(sim.state.commits, sim.headId(), 'renamed.txt').id, sim.headId());
});

test('本地、远程和跟踪的文件提交说明各自更新，fetch 与 push 保留提交时间', () => {
  const sim = new Simulator(), model = new Model();
  const earliest = Date.now(); commit(sim, 'hello.txt', '本地文件\n'); const local = sim.headId(), timestamp = sim.state.commits[local].timestamp;
  assert.ok(timestamp >= earliest && timestamp <= Date.now());
  assert.equal(model.read(sim.state).entries.find(entry => entry.path === 'hello.txt').lastCommit.id, 'C0');
  run(sim, 'git push');
  assert.equal(sim.state.remote.commits[local].timestamp, timestamp);
  const result = sim.commitRemote('main', { baseId: local, tree: { ...sim.headTree(), 'hello.txt': '协作者内容\n' }, message: '远端更新说明' });
  assert.equal(result.ok, true); const remote = sim.state.remote.branches.main;
  assert.equal(model.read(sim.state).entries.find(entry => entry.path === 'hello.txt').lastCommit.id, remote);
  model.selectSource('tracking', sim.state);
  assert.equal(model.read(sim.state).entries.find(entry => entry.path === 'hello.txt').lastCommit.id, local);
  run(sim, 'git fetch');
  assert.equal(model.read(sim.state).entries.find(entry => entry.path === 'hello.txt').lastCommit.id, remote);
  assert.equal(sim.state.commits[remote].timestamp, sim.state.remote.commits[remote].timestamp);
  model.selectSource('local', sim.state);
  assert.equal(model.read(sim.state).entries.find(entry => entry.path === 'hello.txt').lastCommit.id, local);
});

test('历史缺失与异常环不借用另一来源对象，普通原型同名文件也按快照比较', () => {
  const sim = new Simulator(), model = new Model(); commit(sim, 'new.txt', '内容\n'); run(sim, 'git push');
  const id = sim.headId(); delete sim.state.commits.C0;
  model.selectSource('tracking', sim.state);
  assert.equal(model.read(sim.state).entries.find(entry => entry.path === 'hello.txt').lastCommit, null);
  model.selectSource('remote', sim.state);
  assert.equal(model.read(sim.state).entries.find(entry => entry.path === 'hello.txt').lastCommit.id, 'C0');
  const commits = { A: { id: 'A', parents: ['B'], tree: { 'toString': '' } }, B: { id: 'B', parents: ['A'], tree: { 'toString': '' } } };
  assert.equal(latestPathCommit(commits, 'A', 'toString'), null);
  assert.equal(latestPathCommit({}, id, 'new.txt'), null);
  commits.B.parents = []; commits.B.tree = {};
  assert.equal(latestPathCommit(commits, 'A', 'toString').id, 'A');
});

test('相对时间按真实时刻计算，不用提交序号伪造日期，旧数据明确无时间', () => {
  const now = 1800000000000;
  assert.equal(commitAge(now, now), '刚刚');
  assert.equal(commitAge(now - 59999, now), '刚刚');
  assert.equal(commitAge(now - 120000, now), '2 分钟前');
  assert.equal(commitAge(now - 7200000, now), '2 小时前');
  assert.equal(commitAge(now - 172800000, now), '2 天前');
  for (const missing of [undefined, null, NaN, Infinity, 0, 1e20]) assert.equal(commitAge(missing, now), '时间未记录');
});

test('文件行的提交说明独立可点击，详情使用纯文本且收起恢复焦点，不改变仓库', () => {
  const f = fixture(), message = '<img src=x onerror=alert(1)>', text = '<script>alert(1)</script>\n';
  f.sim.editFile('src/new.txt', text); run(f.sim, 'git add .'); run(f.sim, 'git commit -m "' + message + '"'); const id = f.sim.headId();
  commit(f.sim, 'README.md', '另一个较新提交\n'); run(f.sim, 'git push'); const before = f.sim.snapshot();
  f.withDocument(() => {
    f.view.open();
    const row = f.all().find(element => element.className === 'repo-file-row' && element.children[0].attributes['aria-label'] === '打开目录 src');
    const link = row.children.find(element => element.className === 'repo-commit-link');
    assert.equal(link.children[0].textContent, message); assert.equal(link.children[1].textContent, id);
    assert.equal(row.tagName, 'div'); assert.equal(row.children[0].tagName, 'button');
    assert.ok(f.all().every(element => element.tagName !== 'button' || element.children.every(child => child.tagName !== 'button')));
    link.fire('click'); assert.equal(f.view.commitDetails.hidden, false); assert.equal(f.document.activeElement, f.view.commitDetails);
    assert.match(f.view.commitDetailTitle.textContent, /<img/);
    assert.ok(f.all().some(element => element.className === 'commit-diff-code' && element.textContent.includes('<script>')));
    assert.equal(f.all().filter(element => ['img', 'script'].includes(element.tagName)).length, 0);
    const close = f.all().find(element => element.tagName === 'button' && element.textContent === '收起提交详情');
    close.fire('click'); assert.equal(f.view.commitDetails.hidden, true); assert.equal(f.document.activeElement, link);
    row.children[0].fire('click');
    f.all().find(element => element.attributes['aria-label'] === '查看文件 new.txt').fire('click');
    assert.ok(f.all().some(element => element.className === 'repo-file-history'));
    assert.equal(f.view.model.file, 'src/new.txt');
    f.view.sourceSelect.value = 'tracking'; f.view.sourceSelect.fire('change'); assert.equal(f.view.commitDetails.hidden, true);
  });
  assert.deepEqual(f.sim.snapshot(), before);
});
