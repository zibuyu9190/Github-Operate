const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Simulator, SCENES } = require('../simulator.js');

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

function run(sim, text) {
  const result = sim.execute(text); assert.equal(result.ok, true, text + ': ' + result.output); return result;
}

function commitFile(sim, path, text) {
  sim.editFile(path, text); run(sim, 'git add ' + path); run(sim, 'git commit -m "布局练习"'); return sim.headId();
}

test('交替在两分支提交后合并：延续父提交所在列，不因创建顺序交换左右', () => {
  const view = renderer(false), sim = new Simulator('conflict');
  const main = commitFile(sim, 'hello.txt', 'main分支\n');
  run(sim, 'git switch bugFix'); const feature = commitFile(sim, 'hello.txt', 'bugfix\n');
  run(sim, 'git switch main'); assert.equal(run(sim, 'git merge bugFix').conflict, true);
  const merge = commitFile(sim, 'hello.txt', 'main分支\nbugfix\n'), before = sim.snapshot();
  view.graph.draw(sim.state); const { positions } = view.graph.layout(sim.state);
  assert.equal(positions.get(main).x, positions.get('C3').x);
  assert.equal(positions.get(feature).x, positions.get('C2').x);
  assert.ok(positions.get(feature).x < positions.get(main).x);
  assert.ok(positions.get(merge).x > positions.get(feature).x && positions.get(merge).x < positions.get(main).x);
  assert.equal(view.all().filter(e => e.attrs.class === 'commit-edge').length, 7);
  assert.deepEqual(sim.snapshot(), before);
});

test('分支长度不同或轮流追加提交时，已有提交链保持原列，切换 HEAD 不改变排列', () => {
  const view = renderer(false), sim = new Simulator('branches');
  const main = [commitFile(sim, 'main.txt', '1\n'), commitFile(sim, 'main.txt', '2\n'), commitFile(sim, 'main.txt', '3\n')];
  const before = view.graph.layout(sim.state).positions;
  run(sim, 'git switch bugFix'); const feature = [commitFile(sim, 'feature.txt', '1\n'), commitFile(sim, 'feature.txt', '2\n')];
  const layout = view.graph.layout(sim.state);
  for (const id of main) assert.equal(layout.positions.get(id).x, layout.positions.get('C3').x);
  for (const id of feature) assert.equal(layout.positions.get(id).x, layout.positions.get('C2').x);
  for (const [id, point] of before) assert.equal(layout.positions.get(id).x, point.x);
  run(sim, 'git switch main');
  assert.deepEqual(view.graph.layout(sim.state).positions, layout.positions);
});

test('一条分支再次分叉时避开同层已有提交，多分支节点不重叠且画布容纳标签', () => {
  const view = renderer(false), sim = new Simulator('branches');
  run(sim, 'git switch bugFix'); const fork = sim.headId();
  commitFile(sim, 'feature.txt', 'a\n');
  run(sim, 'git checkout ' + fork); run(sim, 'git switch -c extra');
  commitFile(sim, 'extra.txt', 'b\n');
  run(sim, 'git switch main'); commitFile(sim, 'main.txt', 'c\n');
  view.graph.draw(sim.state); const layout = view.graph.layout(sim.state), rows = new Map();
  for (const point of layout.positions.values()) {
    assert.ok(point.x >= 100 && point.x <= layout.width - 100);
    if (!rows.has(point.y)) rows.set(point.y, []); rows.get(point.y).push(point.x);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a - b);
    for (let i = 1; i < row.length; i++) assert.ok(row[i] - row[i - 1] >= 200);
  }
  for (const tag of view.all().filter(e => e.attrs.class === 'branch-tag')) {
    const x = Number(tag.attrs.transform.match(/translate\(([^ ]+)/)[1]);
    const rect = tag.children.find(e => e.tag === 'rect');
    assert.ok(x >= 0 && x + Number(rect.attrs.width) <= layout.width);
  }
});

test('六场景及变基、远程合并后：每条边仍指向真实父提交，重新绘图与 fetch 不改变已有列位置', () => {
  for (const scene of Object.keys(SCENES)) {
    const view = renderer(false), sim = new Simulator(scene);
    if (scene === 'branches') run(sim, 'git merge bugFix');
    if (scene === 'rebase') run(sim, 'git rebase main');
    if (scene === 'reset') run(sim, 'git reset --hard HEAD~1');
    if (scene === 'remote') { run(sim, 'git fetch'); run(sim, 'git pull --no-rebase'); run(sim, 'git push'); }
    const layout = view.graph.layout(sim.state), before = sim.snapshot();
    view.graph.draw(sim.state); view.graph.draw(sim.state);
    assert.deepEqual(view.graph.layout(sim.state).positions, layout.positions);
    assert.deepEqual(sim.snapshot(), before);
    const edges = view.all().filter(e => e.attrs.class === 'commit-edge'); let index = 0;
    for (const commit of layout.commits) for (const parent of commit.parents) {
      const point = layout.positions.get(commit.id), to = layout.positions.get(parent);
      assert.ok(to.y < point.y, scene + ': parent above child');
      const values = edges[index++].attrs.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
      assert.equal(values[0], point.x); assert.equal(values[values.length - 2], to.x);
      assert.equal(edges[index - 1].attrs['marker-end'], 'url(#parent-arrow)');
    }
    assert.equal(edges.length, index);
  }
  const view = renderer(false), sim = new Simulator('remote'), before = view.graph.layout(sim.state).positions;
  run(sim, 'git fetch');
  // fetch 改变标签数量后允许增减纵向留白，但不应交换已有提交的左右列。
  for (const [id, point] of before) assert.equal(view.graph.layout(sim.state).positions.get(id).x, point.x);
});
