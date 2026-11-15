const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator } = require('../simulator.js');
const { Model, View, listEntries, fileStats } = require('../graph-viewer.js').RepositoryBrowser;

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
function fixture() {
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
  let view; try { view = new View(() => ({ state: sim.state }), () => prepares++); } finally { global.document = previous; }
  const withDocument = action => { const previous = global.document; global.document = document; try { return action(); } finally { global.document = previous; } };
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
    f.view.reset(); assert.equal(f.view.model.file, null); assert.equal(f.view.model.source, 'remote');
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
