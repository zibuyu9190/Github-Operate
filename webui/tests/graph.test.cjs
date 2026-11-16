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
  const svg = new Element('svg'); svg.parentElement = { clientWidth: 900, clientHeight: 395 };
  const selections = [], graph = new context.CommitGraph(svg, commit => selections.push(commit.id));
  const all = () => { const found = []; const scan = item => { found.push(item); item.children.forEach(scan); }; scan(svg); return found; };
  return { graph, svg, animations, selections, all };
}

test('提交图布局保留分叉，边指向父提交，节点支持键盘选择', () => {
  const view = renderer(false), sim = new Simulator('branches'); view.graph.draw(sim.state);
  const layout = view.graph.layout(sim.state);
  assert.ok(layout.positions.get('C0').x < layout.positions.get('C1').x);
  assert.equal(layout.positions.get('C2').x, layout.positions.get('C3').x);
  assert.ok(layout.positions.get('C2').y < layout.positions.get('C3').y);
  const edges = view.all().filter(e => e.attrs.class === 'commit-edge'); assert.equal(edges.length, 3); assert.ok(edges.every(e => e.attrs['marker-end'] === 'url(#parent-arrow)'));
  const node = view.all().find(e => e.attrs['aria-label']?.startsWith('C2 ')); node.events.keydown({ key: 'Enter', preventDefault() {} }); assert.deepEqual(view.selections, ['C2']);
});

test('基础历史从左向右展开，节点和标签文字保持正向，所有标签都在画布内', () => {
  const view = renderer(false), sim = new Simulator(); view.graph.draw(sim.state);
  const layout = view.graph.layout(sim.state), points = ['C0', 'C1', 'C2'].map(id => layout.positions.get(id));
  assert.ok(points[0].x < points[1].x && points[1].x < points[2].x);
  assert.ok(points.every(point => point.y === points[0].y));
  assert.ok(layout.width > layout.height);
  for (const tag of layout.labels) {
    assert.ok(tag.x >= 0 && tag.x + tag.width <= layout.width);
    assert.ok(tag.y >= 0 && tag.y + tag.height <= layout.height);
  }
  assert.ok(view.all().every(element => !/rotate|matrix/.test(element.attrs.transform || '')));
  assert.ok(view.all().some(element => element.textContent === 'origin/main'));
  assert.ok(view.all().some(element => element.textContent === 'HEAD'));
});

test('横向画布在主面板、放大弹窗和窄屏中等比缩放，放大后两轴均可滚动', () => {
  const view = renderer(false), sim = new Simulator('branches'); view.graph.draw(sim.state);
  for (const [width, height] of [[900, 395], [1198, 561], [340, 240]]) {
    view.svg.parentElement = { clientWidth: width, clientHeight: height };
    view.graph.setZoom(1);
    assert.equal(parseFloat(view.svg.style.width), width);
    assert.equal(parseFloat(view.svg.style.height), height);
    view.graph.setZoom(2);
    assert.equal(parseFloat(view.svg.style.width), width * 2);
    assert.equal(parseFloat(view.svg.style.height), height * 2);
    view.graph.setZoom(.6);
    assert.equal(parseFloat(view.svg.style.width), width * .6);
    assert.equal(parseFloat(view.svg.style.height), height * .6);
  }
});

for (const reduced of [false, true]) test('分支移动在减少动画偏好为 ' + reduced + ' 时遵循动画策略', () => {
  const view = renderer(reduced), sim = new Simulator('reset'); view.graph.draw(sim.state);
  sim.execute('git reset --hard HEAD~1'); view.graph.draw(sim.state, { animate: true });
  assert.equal(view.animations.length > 0, !reduced);
  assert.ok(view.animations.every(frames => frames.every(frame => !Object.hasOwn(frame, 'transform'))));
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

test('标签拥有独立引用标记并保护离开分支的提交，删除后恢复游离样式', () => {
  const sim = new Simulator(), view = renderer(false);
  sim.editFile('hello.txt', '标签版本\n'); run(sim, 'git add .'); run(sim, 'git commit -m "标签版本"');
  const id = sim.headId(); run(sim, 'git tag v1'); run(sim, 'git reset --hard HEAD~1'); view.graph.draw(sim.state);
  assert.ok(view.all().some(e => e.textContent === 'tag: v1'));
  assert.ok(!String(view.all().find(e => e.attrs['aria-label']?.startsWith(id + ' ')).attrs.class).includes('orphan'));
  run(sim, 'git tag -d v1'); view.graph.draw(sim.state);
  assert.match(view.all().find(e => e.attrs['aria-label']?.startsWith(id + ' ')).attrs.class, /orphan/);
});

function commitFile(sim, path, text) {
  sim.editFile(path, text); run(sim, 'git add ' + path); run(sim, 'git commit -m "布局练习"'); return sim.headId();
}

test('交替在两分支提交后合并：延续父提交通道，不因创建顺序交换上下', () => {
  const view = renderer(false), sim = new Simulator('conflict');
  const main = commitFile(sim, 'hello.txt', 'main分支\n');
  run(sim, 'git switch bugFix'); const feature = commitFile(sim, 'hello.txt', 'bugfix\n');
  run(sim, 'git switch main'); assert.equal(run(sim, 'git merge bugFix').conflict, true);
  const merge = commitFile(sim, 'hello.txt', 'main分支\nbugfix\n'), before = sim.snapshot();
  view.graph.draw(sim.state); const { positions } = view.graph.layout(sim.state);
  assert.equal(positions.get(main).y, positions.get('C3').y);
  assert.equal(positions.get(feature).y, positions.get('C2').y);
  assert.ok(positions.get(feature).y < positions.get(main).y);
  assert.ok(positions.get(merge).y > positions.get(feature).y && positions.get(merge).y < positions.get(main).y);
  assert.equal(view.all().filter(e => e.attrs.class === 'commit-edge').length, 7);
  assert.deepEqual(sim.snapshot(), before);
});

test('分支长度不同或轮流追加提交时，已有提交链保持原通道，切换 HEAD 不改变排列', () => {
  const view = renderer(false), sim = new Simulator('branches');
  const main = [commitFile(sim, 'main.txt', '1\n'), commitFile(sim, 'main.txt', '2\n'), commitFile(sim, 'main.txt', '3\n')];
  const before = view.graph.layout(sim.state).positions;
  run(sim, 'git switch bugFix'); const feature = [commitFile(sim, 'feature.txt', '1\n'), commitFile(sim, 'feature.txt', '2\n')];
  const layout = view.graph.layout(sim.state);
  for (const id of main) assert.equal(layout.positions.get(id).y, layout.positions.get('C3').y);
  for (const id of feature) assert.equal(layout.positions.get(id).y, layout.positions.get('C2').y);
  for (const [id, point] of before) assert.equal(layout.positions.get(id).y, point.y);
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
    assert.ok(point.y >= 100 && point.y <= layout.height - 100);
    if (!rows.has(point.x)) rows.set(point.x, []); rows.get(point.x).push(point.y);
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

test('六场景及变基、远程合并后：每条边仍指向真实父提交，重新绘图与 fetch 不改变已有通道', () => {
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
      assert.ok(to.x < point.x, scene + ': parent left of child');
      const values = edges[index++].attrs.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
      // 多条边分别连接圆周上的独立入口，同时校验确实落在对应子、父节点旁。
      const radius = Number(view.all().find(e => e.tag === 'circle').attrs.r);
      assert.ok(Math.abs(Math.hypot(values[0] - point.x, values[1] - point.y) - (radius + 1)) < .001);
      assert.ok(Math.abs(Math.hypot(values.at(-2) - to.x, values.at(-1) - to.y) - (radius + 6)) < .001);
      assert.ok(values[0] < point.x && values.at(-2) > to.x);
      assert.equal(edges[index - 1].attrs['marker-end'], 'url(#parent-arrow)');
    }
    assert.equal(edges.length, index);
  }
  const view = renderer(false), sim = new Simulator('remote'), before = view.graph.layout(sim.state).positions;
  run(sim, 'git fetch');
  // fetch 改变标签数量后允许增减横向留白，但不应交换已有提交的上下通道。
  for (const [id, point] of before) assert.equal(view.graph.layout(sim.state).positions.get(id).y, point.y);
});

/** 从实际 SVG 路径取样并检测线段穿框，独立于布局器的通道计算。 */
function pathSegments(d, offset = [0, 0]) {
  const tokens = d.match(/[MLCQ]|-?\d+(?:\.\d+)?/g), segments = []; let point;
  while (tokens.length) {
    const command = tokens.shift(), count = { M: 2, L: 2, Q: 4, C: 6 }[command];
    assert.ok(count, '未知 SVG 路径指令：' + command);
    const values = tokens.splice(0, count).map(Number), controls = [];
    for (let i = 0; i < count; i += 2) controls.push([values[i] + offset[0], values[i + 1] + offset[1]]);
    if (command === 'M') { point = controls[0]; continue; }
    const curve = [point, ...controls];
    for (let step = 1; step <= 128; step++) {
      const t = step / 128; let points = curve;
      while (points.length > 1) points = points.slice(1).map((p, i) => p.map((v, axis) => points[i][axis] * (1 - t) + v * t));
      segments.push([point, points[0]]); point = points[0];
    }
  }
  return segments;
}

function crossesBox([a, b], box) {
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 2; axis++) {
    const delta = b[axis] - a[axis], low = (axis ? box.y : box.x) - 3;
    const high = (axis ? box.y + box.height : box.x + box.width) + 3;
    if (!delta) { if (a[axis] < low || a[axis] > high) return false; }
    else {
      const ends = [(low - a[axis]) / delta, (high - a[axis]) / delta].sort((x, y) => x - y);
      enter = Math.max(enter, ends[0]); leave = Math.min(leave, ends[1]);
      if (enter > leave) return false;
    }
  }
  return true;
}

function assertLabelsClear(view, state) {
  const before = JSON.stringify(state); view.graph.draw(state);
  const tags = view.all().filter(e => e.attrs.class === 'branch-tag').map(tag => {
    const [x, y] = tag.attrs.transform.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const rect = tag.children.find(e => e.tag === 'rect');
    const height = Math.max(Number(rect.attrs.height), ...tag.children.filter(e => e.tag === 'text').map(e => Number(e.attrs.y) + 6));
    return { key: tag.attrs['data-ref'], x, y, width: Number(rect.attrs.width), height, pointer: tag.children.find(e => e.attrs.class === 'branch-pointer').attrs.d };
  });
  const lines = view.all().filter(e => e.attrs.class === 'commit-edge').map(e => ({ key: '提交连线', segments: pathSegments(e.attrs.d) }));
  for (const tag of tags) lines.push({ key: tag.key, segments: pathSegments(tag.pointer, [tag.x, tag.y]) });
  for (const line of lines) for (const tag of tags) {
    if (line.key !== tag.key) assert.equal(line.segments.some(segment => crossesBox(segment, tag)), false, line.key + ' 不应穿过 ' + tag.key);
  }
  for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
    const a = tags[i], b = tags[j];
    assert.ok(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y, a.key + ' 与 ' + b.key + ' 不应重叠');
  }
  assert.equal(JSON.stringify(state), before);
}

test('根提交挂 origin/main 且右侧分为三支：标签与提交线、其他引用指针留有间距', () => {
  const view = renderer(false), sim = new Simulator('basic');
  // 固定根提交上的远程引用，保留此布局回归用例，不依赖基础场景的预置历史长度。
  run(sim, 'git reset --hard C0');
  sim.state.tracking.main = 'C0'; sim.state.remote.branches.main = 'C0';
  run(sim, 'git switch -c dev'); commitFile(sim, 'dev.txt', 'dev\n');
  run(sim, 'git switch main'); run(sim, 'git switch -c test01'); commitFile(sim, 'test.txt', 'test\n');
  run(sim, 'git switch main'); commitFile(sim, 'main.txt', 'main\n');
  assertLabelsClear(view, sim.state);
  assert.equal(sim.state.tracking.main, 'C0');
  for (let i = 0; i < 7; i++) run(sim, 'git branch feature-with-a-long-branch-name-' + i);
  assertLabelsClear(view, sim.state);
  sim.simulateRemote(); assertLabelsClear(view, sim.state);
  run(sim, 'git fetch'); assertLabelsClear(view, sim.state);
});

test('六类场景和跨层合并：长名称、多层标签及 HEAD 说明均不被连线穿过', () => {
  const view = renderer(false);
  for (const scene of Object.keys(SCENES)) assertLabelsClear(view, new Simulator(scene).state);
  const sim = new Simulator('basic'); run(sim, 'git branch dev');
  for (let i = 0; i < 4; i++) commitFile(sim, 'main.txt', String(i));
  run(sim, 'git switch dev'); commitFile(sim, 'dev.txt', 'dev');
  run(sim, 'git branch very-long-branch-name-for-label-clearance');
  run(sim, 'git switch main'); run(sim, 'git merge dev');
  assertLabelsClear(view, sim.state);
});

/** 按截图构造不等长分支；旋转后的镜像历史确保绕行策略不偏向固定一侧。 */
function unevenMerge(longOnLeft) {
  const sim = new Simulator('basic');
  run(sim, 'git switch -c ' + (longOnLeft ? 'dev' : 'topic'));
  commitFile(sim, longOnLeft ? 'dev.txt' : 'topic.txt', '1\n');
  run(sim, 'git switch main'); run(sim, 'git switch -c ' + (longOnLeft ? 'topic' : 'dev'));
  commitFile(sim, longOnLeft ? 'topic.txt' : 'dev.txt', '1\n');
  if (longOnLeft) run(sim, 'git switch dev');
  commitFile(sim, 'dev.txt', '2\n'); run(sim, 'git push -u origin dev');
  run(sim, 'git merge topic'); run(sim, 'git branch -d topic');
  return sim;
}

function sampledLength(segments) { return segments.reduce((sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]), 0); }

/** 独立检测实际路径的相交与贴线，不读取布局器的候选路径或评分。 */
function segmentsMeet([a, b], [c, d]) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const epsilon = .00001;
  if (Math.max(a[0], b[0]) + epsilon < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) + epsilon < Math.min(a[0], b[0]) || Math.max(a[1], b[1]) + epsilon < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) + epsilon < Math.min(a[1], b[1])) return false;
  return cross(a, b, c) * cross(a, b, d) <= epsilon && cross(c, d, a) * cross(c, d, b) <= epsilon;
}

for (const left of [false, true]) test('不等长分支合并与镜像：连线走内部短路径，无交叉或共享线段，上侧长链=' + left, () => {
  const sim = unevenMerge(left), view = renderer(false), before = sim.snapshot();
  const layout = view.graph.layout(sim.state), merge = layout.objects[sim.headId()];
  const route = layout.edges.find(edge => edge.commit === merge.id && edge.parent === merge.parents[1]);
  const segments = pathSegments(route.path), child = layout.positions.get(merge.id), parent = layout.positions.get(merge.parents[1]);
  const yMin = Math.min(child.y, parent.y) - 12, yMax = Math.max(child.y, parent.y) + 12;
  assert.ok(segments.every(segment => segment.every(([, y]) => y >= yMin && y <= yMax)), '跨层线应留在两个端点之间，避免绕到画布边缘');
  assert.ok(sampledLength(segments) < child.x - parent.x + Math.abs(child.y - parent.y) + 60, '跨层线长度应接近必要的横纵距离');
  const routes = layout.edges.map(edge => ({ edge, segments: pathSegments(edge.path) }));
  for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
    assert.ok(!routes[i].segments.some(a => routes[j].segments.some(b => segmentsMeet(a, b))), `${routes[i].edge.commit}→${routes[i].edge.parent} 与 ${routes[j].edge.commit}→${routes[j].edge.parent} 不应交叉或贴合`);
  }
  assertLabelsClear(view, sim.state);
  assert.deepEqual(sim.snapshot(), before);
});

test('同一父提交的多条入线和合并提交的出线分别连接独立圆周入口', () => {
  const view = renderer(false), sim = unevenMerge(false), layout = view.graph.layout(sim.state);
  for (const [field, end] of [['parent', true], ['commit', false]]) {
    const groups = new Map();
    for (const edge of layout.edges) {
      const segments = pathSegments(edge.path), point = end ? segments.at(-1)[1] : segments[0][0];
      if (!groups.has(edge[field])) groups.set(edge[field], []); groups.get(edge[field]).push(point);
    }
    for (const points of groups.values()) for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) assert.ok(Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) >= 12);
  }
});

test('跨层合并绕开中间节点、长分支标签和 HEAD 说明，重复绘制路径稳定', () => {
  const sim = new Simulator('basic'), view = renderer(false);
  run(sim, 'git branch topic');
  for (let i = 0; i < 5; i++) commitFile(sim, 'main.txt', String(i));
  run(sim, 'git switch topic'); commitFile(sim, 'topic.txt', 'topic');
  for (let i = 0; i < 5; i++) run(sim, 'git branch long-feature-label-for-routing-' + i);
  run(sim, 'git switch main'); run(sim, 'git merge topic');
  assertLabelsClear(view, sim.state);
  const layout = view.graph.layout(sim.state), radius = Number(view.all().find(e => e.tag === 'circle').attrs.r);
  for (const edge of layout.edges) for (const [id, point] of layout.positions) {
    if (id === edge.commit || id === edge.parent) continue;
    assert.equal(pathSegments(edge.path).some(segment => crossesBox(segment, { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 })), false, edge.commit + '→' + edge.parent + ' 不应穿过 ' + id);
  }
  assert.deepEqual(view.graph.layout(sim.state).edges, layout.edges);
});
