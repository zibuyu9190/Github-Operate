const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Simulator } = require('../simulator.js');

/** 最小 DOM 仅用于观察真实绘图器输出与动画调用，不替代浏览器布局验证。 */
function renderer(reducedMotion) {
  const animations = [];
  class Element {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.style = {}; this.events = {}; this.classList = { add() {}, remove() {} }; }
    setAttribute(name, value) { this.attrs[name] = value; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, handler) { this.events[name] = handler; }
    animate(frames) { animations.push(frames); }
    querySelectorAll() { return []; }
  }
  const context = vm.createContext({ document: { createElementNS: (_ns, tag) => new Element(tag) }, matchMedia: () => ({ matches: reducedMotion }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../graph.js'), 'utf8'), context);
  const svg = new Element('svg'); svg.parentElement = { clientHeight: 395 };
  const selections = [], graph = new context.CommitGraph(svg, commit => selections.push(commit.id));
  const all = () => { const found = []; const scan = item => { found.push(item); item.children.forEach(scan); }; scan(svg); return found; };
  return { graph, svg, animations, selections, all };
}

test('提交图布局保留分叉，边指向父提交，节点支持键盘选择', () => {
  const view = renderer(false), sim = new Simulator('branches'); view.graph.draw(sim.state);
  const layout = view.graph.layout(sim.state);
  assert.ok(layout.positions.get('C0').y < layout.positions.get('C1').y);
  assert.equal(layout.positions.get('C2').y, layout.positions.get('C3').y);
  assert.ok(layout.positions.get('C2').x < layout.positions.get('C3').x);
  const edges = view.all().filter(e => e.attrs.class === 'commit-edge'); assert.equal(edges.length, 3); assert.ok(edges.every(e => e.attrs['marker-end'] === 'url(#parent-arrow)'));
  const node = view.all().find(e => e.attrs['aria-label']?.startsWith('C2 ')); node.events.keydown({ key: 'Enter', preventDefault() {} }); assert.deepEqual(view.selections, ['C2']);
});

for (const reduced of [false, true]) test('分支移动在减少动画偏好为 ' + reduced + ' 时遵循动画策略', () => {
  const view = renderer(reduced), sim = new Simulator('reset'); view.graph.draw(sim.state);
  sim.execute('git reset --hard HEAD~1'); view.graph.draw(sim.state, { animate: true });
  assert.equal(view.animations.length > 0, !reduced);
  const orphan = view.all().find(e => e.attrs['aria-label']?.startsWith('C2 ')); assert.match(orphan.attrs.class, /orphan/);
});

test('fetch 前远程独有节点有区别标记，分支文本保持纯文本', () => {
  const view = renderer(false), sim = new Simulator(); sim.simulateRemote(); sim.execute('git branch "<img>"'); view.graph.draw(sim.state);
  assert.equal(view.all().filter(e => e.tag === 'img').length, 0);
  assert.ok(view.all().some(e => e.textContent === '<img>'));
  assert.ok(view.all().some(e => String(e.attrs.class).includes('remote-only')));
});
