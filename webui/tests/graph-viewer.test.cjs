const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Simulator, edits } = require('../simulator.js');

/** 只验证弹窗的 DOM 搬移、事件和状态恢复；原生焦点限制与实际排版另用浏览器检查。 */
function fixture() {
  let document;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.classes = new Set();
      this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
      this.clientWidth = 600; this.clientHeight = 300; this.scrollTop = 0; this.scrollLeft = 0;
    }
    append(...children) {
      for (const item of children) {
        if (item.parentNode) item.parentNode.children.splice(item.parentNode.children.indexOf(item), 1);
        item.parentNode = this; this.children.push(item);
      }
    }
    before(item) { item.parentNode = this.parentNode; this.parentNode.children.splice(this.parentNode.children.indexOf(this), 0, item); }
    replaceWith(item) {
      if (item.parentNode) item.parentNode.children.splice(item.parentNode.children.indexOf(item), 1);
      const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1, item); item.parentNode = parent; this.parentNode = null;
    }
    replaceChildren(...items) { this.children.forEach(item => { item.parentNode = null; }); this.children = []; this.append(...items); }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    fire(name, values = {}) { for (const callback of this.events[name] || []) callback({ target: this, ...values }); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 610, bottom: 310 }; }
    querySelector() { return null; }
    closest() { return this.tag === 'g' ? this : null; }
    focus() { document.activeElement = this; }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
  }
  const toolbar = new Element('div'), parent = new Element('section'), stage = new Element('div'), svg = new Element('svg'), details = new Element('details');
  document = { body: new Element('body'), createElement: tag => new Element(tag), createComment: () => new Element('#comment'), querySelector: () => toolbar };
  document.body.append(toolbar, parent); parent.append(stage, details); stage.append(svg); document.activeElement = stage;
  const context = vm.createContext({ document, GitSimulator: { edits }, window: { getSelection: () => ({ toString: () => '' }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../graph-viewer.js'), 'utf8'), context);
  const sim = new Simulator('branches'), before = sim.snapshot(), selections = []; let prepares = 0;
  const graph = { zoom: 1.8, onSelect: commit => selections.push(commit.id), draw() {}, resize() {}, setZoom(value) { this.zoom = Math.max(.6, Math.min(2.5, value)); } };
  const viewer = new context.GitGraphViewer(graph, stage, () => ({ title: '分支与合并', state: sim.state }), () => { prepares++; });
  return { viewer, graph, stage, svg, details, parent, document, sim, before, selections, prepares: () => prepares, Element };
}

test('重复打开关闭大图只搬移原画布，不复制 SVG，保留仓库、缩放与滚动位置', () => {
  const f = fixture(); f.stage.scrollLeft = 23; f.stage.scrollTop = 79;
  for (let n = 0; n < 3; n++) {
    f.viewer.open(); f.viewer.open();
    assert.equal(f.viewer.canvas.children[0], f.stage); assert.equal(f.stage.children[0], f.svg); assert.equal(f.graph.zoom, 1);
    f.viewer.zoomIn.fire('click'); f.stage.scrollTop = 200; f.stage.scrollLeft = 100;
    f.viewer.closeButton.fire('click');
    assert.deepEqual(f.parent.children, [f.stage, f.details]); assert.equal(f.graph.zoom, 1.8);
    assert.equal(f.stage.scrollLeft, 23); assert.equal(f.stage.scrollTop, 79); assert.equal(f.document.activeElement, f.stage);
    assert.equal(f.document.body.classes.has('graph-viewer-open'), false); assert.deepEqual(f.sim.snapshot(), f.before);
  }
  assert.equal(f.prepares(), 3);
});

test('画布与独立按钮均能打开，键盘仅处理画布本身，滚动条点击不误触发', () => {
  const f = fixture();
  f.stage.fire('click', { clientX: 620, clientY: 20 }); assert.ok(!f.viewer.dialog.open);
  f.stage.fire('click', { clientX: 40, clientY: 40 }); assert.equal(f.viewer.dialog.open, true); f.viewer.dialog.close();
  let prevented = false;
  f.stage.fire('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.viewer.dialog.open, true); f.viewer.dialog.close();
  f.stage.fire('keydown', { key: 'Enter', target: f.svg, preventDefault() { throw new Error('不能截获节点按键'); } });
  assert.equal(f.viewer.dialog.open, false); f.viewer.trigger.fire('click'); assert.equal(f.viewer.dialog.open, true);
  assert.equal(f.viewer.trigger.attrs['aria-haspopup'], 'dialog');
});

test('弹窗内点击不误关，遮罩点击关闭后可恢复，缩放端点正确禁用按钮', () => {
  const f = fixture(); f.viewer.open();
  f.viewer.dialog.fire('click', { clientX: 40, clientY: 40 }); assert.equal(f.viewer.dialog.open, true);
  f.viewer.zoom(.6); assert.equal(f.viewer.zoomOut.disabled, true); assert.equal(f.viewer.zoomIn.disabled, false);
  f.viewer.zoom(2.5); assert.equal(f.viewer.zoomIn.disabled, true); assert.equal(f.viewer.zoomLabel.textContent, '250%');
  f.viewer.dialog.fire('click', { clientX: 0, clientY: 0 });
  assert.equal(f.viewer.dialog.open, false); assert.equal(f.stage.parentNode, f.parent);
});

test('关闭事件延迟时立即重开，大图仍保留在弹窗内，最终恢复原位置和缩放', () => {
  const f = fixture(); f.viewer.open();
  f.viewer.dialog.open = false; // 模拟原生 close() 已关闭，但 close 事件尚未派发。
  f.viewer.open(); f.viewer.dialog.fire('close');
  assert.equal(f.viewer.dialog.open, true); assert.equal(f.stage.parentNode, f.viewer.canvas);
  f.viewer.dialog.close();
  assert.deepEqual(f.parent.children, [f.stage, f.details]); assert.equal(f.graph.zoom, 1.8);
});

test('节点更新纯文本详情但默认折叠，手动展开状态保留，文件中的 HTML 不生成元素', () => {
  const f = fixture(), commit = { id: 'C9', hash: 'test', message: '<img src=x>', parents: ['C1'], tree: { '<script>.txt': '<img onerror=alert(1)>' } };
  f.viewer.open(); f.graph.onSelect(commit, true);
  assert.deepEqual(f.selections, ['C9']); assert.equal(f.viewer.details.open, false);
  assert.equal(f.viewer.summary.textContent, 'C9 · <img src=x>（仅远程）');
  const elements = descendants(f.viewer.content);
  assert.ok(elements.some(item => item.textContent === '新增 · <script>.txt'));
  assert.ok(diffRows(f.viewer.content, 'added').some(row => row[2] === '+' && row[3] === '<img onerror=alert(1)>'));
  assert.equal(elements.some(item => ['img', 'script'].includes(item.tag)), false);
  f.viewer.details.open = true; f.graph.onSelect(f.sim.state.commits.C0, false);
  assert.equal(f.viewer.details.open, true);
  f.viewer.dialog.close(); f.viewer.open();
  assert.equal(f.viewer.details.open, false); assert.equal(f.viewer.content.children.length, 0);
});

function descendants(element) { return element.children.flatMap(child => [child, ...descendants(child)]); }

function diffRows(element, kind) {
  return descendants(element).filter(item => item.className?.split(' ').includes('commit-diff-row') && (!kind || item.className.split(' ').includes('commit-diff-' + kind)))
    .map(row => row.children.map(cell => cell.textContent));
}

function changedText(element, kind) { return diffRows(element, kind).map(row => row[2] + ' ' + row[3]); }

test('远程节点优先展示本次新增行，连续提交与 fetch 后均以实际父提交为基准', () => {
  const f = fixture(); f.viewer.open();
  for (let index = 0; index < 2; index++) {
    const order = f.sim.state.nextId, result = f.sim.simulateRemote();
    const commit = f.sim.state.remote.commits[result.commitId];
    f.graph.onSelect(commit, true);
    const elements = descendants(f.viewer.content);
    const added = changedText(f.viewer.content, 'added');
    assert.deepEqual(added, index === 0 ? ['+ 团队协作记录', '+ 协作者更新 ' + order] : ['+ 协作者更新 ' + order]);
    assert.equal(f.viewer.content.children.at(-1).className, 'commit-full-snapshot');
    assert.ok(!f.viewer.content.children.at(-1).open);
    assert.equal(f.viewer.details.scrollTop, 0);
    f.sim.execute('git fetch'); f.graph.onSelect(f.sim.state.commits[commit.id], false);
    assert.deepEqual(changedText(f.viewer.content, 'added'), added);
  }
});

test('内容替换、整文件删除与空文件新增分别标记，初始和空改动提交明确说明', () => {
  const f = fixture();
  const original = f.sim.headId(), oldText = f.sim.headTree()['hello.txt'];
  f.sim.editFile('hello.txt', '新问候\n'); f.sim.deleteFile('notes.txt'); f.sim.editFile('empty.txt', '');
  f.sim.execute('git add .'); f.sim.execute('git commit -m "修改及删除"');
  f.viewer.showCommit(f.sim.state.commits[f.sim.headId()], false);
  const elements = descendants(f.viewer.content);
  assert.ok(elements.some(item => item.textContent === '修改 · hello.txt'));
  assert.ok(elements.some(item => item.textContent === '删除 · notes.txt'));
  assert.ok(elements.some(item => item.textContent === '新增 · empty.txt'));
  assert.ok(elements.some(item => item.textContent === '新增空文件'));
  assert.ok(changedText(f.viewer.content, 'removed').includes('− ' + oldText.split('\n')[0]));
  assert.ok(changedText(f.viewer.content, 'added').includes('+ 新问候'));
  const root = f.sim.state.commits.C0; f.viewer.showCommit(root, false);
  assert.ok(descendants(f.viewer.content).some(item => item.textContent?.includes('相对空仓库')));
  f.viewer.showCommit({ ...root, parents: [original], tree: f.sim.state.commits[original].tree }, false);
  assert.ok(descendants(f.viewer.content).some(item => item.textContent === '本次提交没有文件内容变化。'));
});

test('合并节点对比第一父提交，缺失父快照不伪造全部新增', () => {
  const f = fixture(), first = f.sim.headId();
  const result = f.sim.execute('git merge bugFix'); assert.equal(result.ok, true);
  const commit = f.sim.state.commits[f.sim.headId()];
  assert.equal(commit.parents[0], first); f.viewer.showCommit(commit, false);
  const elements = descendants(f.viewer.content);
  assert.ok(elements.some(item => item.textContent?.includes('相对第一父提交 ' + first)));
  assert.ok(elements.some(item => item.textContent === '修改 · hello.txt'));
  assert.ok(!elements.some(item => item.textContent === '修改 · notes.txt'));
  f.viewer.showCommit({ ...commit, parents: ['C999'] }, true);
  assert.ok(descendants(f.viewer.content).some(item => item.textContent === '父提交快照不可用，请查看完整文件快照。'));
  assert.equal(descendants(f.viewer.content).some(item => item.className?.includes('commit-diff-added')), false);
});

test('与对象原型同名的普通文件仍按新增文本显示，快照与仓库保持只读', () => {
  const f = fixture(), before = f.sim.snapshot(), tree = { ...f.sim.headTree(), toString: '普通文本文件\n' };
  const commit = { id: 'C99', hash: 'test', parents: [f.sim.headId()], message: '新增特殊名称文件', tree };
  f.viewer.showCommit(commit, true);
  const elements = descendants(f.viewer.content);
  assert.ok(elements.some(item => item.textContent === '新增 · toString'));
  assert.ok(changedText(f.viewer.content, 'added').includes('+ 普通文本文件'));
  assert.deepEqual(f.sim.snapshot(), before);
});

/** 直接调用三处入口共用的渲染器，校验对外可见的行号、符号和文本，而非内部差异算法。 */
function renderDiff(before, after) {
  const f = fixture(), tree = text => text === undefined ? {} : { 'sample.txt': text };
  f.viewer.constructor.renderCommit(f.viewer.content, { id: 'C9', hash: 'test', parents: ['BASE'], tree: tree(after) },
    { commits: { BASE: { tree: tree(before) } }, remote: { commits: {} } });
  const elements = descendants(f.viewer.content);
  return { rows: diffRows(f.viewer.content), headers: elements.filter(item => item.className === 'commit-diff-hunk').map(row => row.children[0].textContent), elements };
}

test('统一差异显示新旧行号、增删符号及未修改上下文，替换不会错位', () => {
  const f = renderDiff('甲\n乙\n旧内容\n丁\n戊\n', '甲\n乙\n新内容\n丁\n戊\n');
  assert.deepEqual(f.headers, ['@@ -1,5 +1,5 @@']);
  assert.deepEqual(f.rows, [['1', '1', '', '甲'], ['2', '2', '', '乙'], ['3', '', '−', '旧内容'], ['', '3', '+', '新内容'], ['4', '4', '', '丁'], ['5', '5', '', '戊']]);
  assert.deepEqual(f.elements.filter(item => item.tag === 'th').map(item => item.textContent), ['旧行号', '新行号', '变化', '内容']);
});

test('插入和删除后新旧行号独立累计，相邻改动共享上下文且不重复行', () => {
  const f = renderDiff('a\nb\nc\nd\ne\nf\n', 'x\na\nb\nc\ne\nf\ny\n');
  assert.deepEqual(f.headers, ['@@ -1,6 +1,7 @@']);
  assert.deepEqual(f.rows, [['', '1', '+', 'x'], ['1', '2', '', 'a'], ['2', '3', '', 'b'], ['3', '4', '', 'c'], ['4', '', '−', 'd'], ['5', '5', '', 'e'], ['6', '6', '', 'f'], ['', '7', '+', 'y']]);
});

test('远距离改动分为两个片段，各保留三行上下文，省略行后行号仍对应完整文件', () => {
  const before = Array.from({ length: 20 }, (_, i) => '行' + (i + 1)), after = [...before]; after[1] = '修改2'; after[17] = '修改18';
  const f = renderDiff(before.join('\n') + '\n', after.join('\n') + '\n');
  assert.deepEqual(f.headers, ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,6 @@']);
  assert.deepEqual(f.rows.filter(row => row[2] === '+'), [['', '2', '+', '修改2'], ['', '18', '+', '修改18']]);
  assert.equal(f.rows.some(row => Number(row[0]) >= 6 && Number(row[0]) <= 14), false);
  assert.deepEqual(f.rows.at(-1), ['20', '20', '', '行20']);
});

test('整文件新增、删除及新增空行使用正确空侧范围，空文件仍有明确说明', () => {
  const added = renderDiff(undefined, '第一行\n\n末行\n');
  assert.deepEqual(added.headers, ['@@ -0,0 +1,3 @@']);
  assert.deepEqual(added.rows, [['', '1', '+', '第一行'], ['', '2', '+', ''], ['', '3', '+', '末行']]);
  const removed = renderDiff('第一行\n末行\n', undefined);
  assert.deepEqual(removed.headers, ['@@ -1,2 +0,0 @@']);
  assert.deepEqual(removed.rows, [['1', '', '−', '第一行'], ['2', '', '−', '末行']]);
  for (const [before, after, label] of [[undefined, '', '新增空文件'], ['', undefined, '删除空文件']]) {
    const f = renderDiff(before, after); assert.deepEqual(f.rows, []); assert.deepEqual(f.headers, []);
    assert.ok(f.elements.some(item => item.textContent === label));
  }
});

test('仅末尾换行变化不会伪装成空行，缺少换行的对应版本明确标注', () => {
  const f = renderDiff('相同文字', '相同文字\n');
  assert.deepEqual(f.rows, [['1', '', '−', '相同文字'], ['', '1', '+', '相同文字']]);
  assert.deepEqual(f.headers, ['@@ -1 +1 @@']);
  const notes = f.elements.filter(item => item.className === 'commit-diff-note');
  assert.equal(notes.length, 1); assert.equal(notes[0].children[0].textContent, '\\ 文件末尾没有换行');
  assert.equal(renderDiff('甲\n乙', '甲\n丙').elements.filter(item => item.className === 'commit-diff-note').length, 2);
});

test('CRLF 文本与 HTML、缩进、空格保持纯文本，不生成可执行元素', () => {
  const f = renderDiff('旧\r\n', '  <img src=x onerror=alert(1)>\r\n\t末尾  \r\n');
  assert.deepEqual(f.rows, [['1', '', '−', '旧'], ['', '1', '+', '  <img src=x onerror=alert(1)>'], ['', '2', '+', '\t末尾  ']]);
  assert.equal(f.elements.some(item => ['img', 'script'].includes(item.tag)), false);
  assert.equal(f.elements.some(item => item.className === 'commit-diff-note'), false);
});
