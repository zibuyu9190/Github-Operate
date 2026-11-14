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

test('节点仍调用原快照回调，弹窗就地显示纯文本快照，文件中的 HTML 不生成元素', () => {
  const f = fixture(), commit = { id: 'C9', hash: 'test', message: '<img src=x>', parents: ['C1'], tree: { '<script>.txt': '<img onerror=alert(1)>' } };
  f.viewer.open(); f.graph.onSelect(commit, true);
  assert.deepEqual(f.selections, ['C9']); assert.equal(f.viewer.details.open, true);
  assert.equal(f.viewer.summary.textContent, 'C9 · <img src=x>（仅远程）');
  const elements = descendants(f.viewer.content);
  assert.ok(elements.some(item => item.textContent === '新增 · <script>.txt'));
  assert.ok(elements.some(item => item.className?.includes('commit-diff-added') && item.textContent === '+ <img onerror=alert(1)>'));
  assert.equal(elements.some(item => ['img', 'script'].includes(item.tag)), false);
  f.viewer.dialog.close(); f.viewer.open();
  assert.equal(f.viewer.details.open, false); assert.equal(f.viewer.content.children.length, 0);
});

function descendants(element) { return element.children.flatMap(child => [child, ...descendants(child)]); }

test('远程节点优先展示本次新增行，连续提交与 fetch 后均以实际父提交为基准', () => {
  const f = fixture(); f.viewer.open();
  for (let index = 0; index < 2; index++) {
    const order = f.sim.state.nextId, result = f.sim.simulateRemote();
    const commit = f.sim.state.remote.commits[result.commitId];
    f.graph.onSelect(commit, true);
    const elements = descendants(f.viewer.content);
    const added = elements.filter(item => item.className?.includes('commit-diff-added')).map(item => item.textContent);
    assert.deepEqual(added, index === 0 ? ['+ 团队协作记录', '+ 协作者更新 ' + order] : ['+ 协作者更新 ' + order]);
    assert.equal(f.viewer.content.children.at(-1).className, 'commit-full-snapshot');
    assert.ok(!f.viewer.content.children.at(-1).open);
    assert.equal(f.viewer.details.scrollTop, 0);
    f.sim.execute('git fetch'); f.graph.onSelect(f.sim.state.commits[commit.id], false);
    assert.deepEqual(descendants(f.viewer.content).filter(item => item.className?.includes('commit-diff-added')).map(item => item.textContent), added);
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
  assert.ok(elements.some(item => item.className?.includes('commit-diff-removed') && item.textContent === '− ' + oldText.split('\n')[0]));
  assert.ok(elements.some(item => item.className?.includes('commit-diff-added') && item.textContent === '+ 新问候'));
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
  assert.ok(elements.some(item => item.className?.includes('commit-diff-added') && item.textContent === '+ 普通文本文件'));
  assert.deepEqual(f.sim.snapshot(), before);
});
