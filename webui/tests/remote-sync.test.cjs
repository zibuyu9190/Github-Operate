const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, RemoteWorkspace } = require('../simulator.js');
const { SyncView } = require('../repo-status.js');

function fixture() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.attributes = {}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const panel = new Element('details'); panel.ownerDocument = { createElement: tag => new Element(tag) };
  const view = new SyncView(panel);
  const text = element => element.textContent + element.children.map(text).join('');
  return { panel, view, rows: () => view.rows.children.map(row => row.children.map(text)) };
}

function run(sim, command) { const result = sim.execute(command); assert.equal(result.ok, true, result.output); }

test('远程同步区默认折叠，刷新状态保留用户展开选择，重置后恢复折叠', () => {
  const f = fixture(), sim = new Simulator(), before = sim.snapshot();
  assert.equal(f.panel.open, false); f.view.update(sim.state);
  assert.equal(f.panel.children[0].tagName, 'summary'); assert.equal(f.view.owner.textContent, '我的本地');
  assert.deepEqual(f.rows(), [['main', 'C2', 'C2']]);
  f.panel.open = true; f.view.update(sim.state); assert.equal(f.panel.open, true);
  f.view.reset(); assert.equal(f.panel.open, false); assert.deepEqual(sim.snapshot(), before);
});

test('身份切换只读取各自 origin 引用，协作者 push 后另一方保持旧记录直到 fetch', () => {
  const sim = new Simulator(), f = fixture();
  const peer = new RemoteWorkspace('main', sim.state.remote.commits[sim.state.remote.branches.main], sim.state.remote);
  peer.editFile('peer.txt', '协作者新增\n');
  for (const command of ['git add .', 'git commit -m "协作者修改"', 'git push']) assert.equal(peer.execute(sim, command).ok, true);
  const latest = peer.baseId, mineBefore = sim.snapshot(), peerBefore = peer.commandContext(sim).state;
  f.view.update(sim.state); assert.deepEqual(f.rows(), [['main', latest, 'C2未同步']]);
  f.panel.open = true; f.view.update(peer.commandContext(sim).state, 'remote');
  assert.equal(f.view.owner.textContent, '协作者本地'); assert.equal(f.view.trackingHeading.textContent, '协作者 origin/*');
  assert.deepEqual(f.rows(), [['main', latest, latest]]); assert.equal(f.panel.open, true);
  assert.match(f.view.note.textContent, /协作者本地保存/);
  assert.deepEqual(sim.snapshot(), mineBefore); assert.deepEqual(peer.commandContext(sim).state, peerBefore);
  f.view.update(sim.state); assert.equal(f.view.trackingHeading.textContent, '我的 origin/*');
  run(sim, 'git fetch'); f.view.update(sim.state); assert.deepEqual(f.rows(), [['main', latest, latest]]);
  assert.equal(sim.headId(), 'C2');
});

test('合并负责人单独 fetch，协作者的跟踪引用和本地分支保持各自状态', () => {
  const sim = new Simulator(), f = fixture();
  const origin = sim.state.remote, start = origin.commits[origin.branches.main];
  const peer = new RemoteWorkspace('main', start, origin);
  const integrator = new RemoteWorkspace('main', start, origin, 'integrator');
  run(sim, 'git switch -c dev'); run(sim, 'git push -u origin dev');
  f.view.update(integrator.commandContext(sim).state, 'integrator');
  assert.equal(f.view.trackingHeading.textContent, '合并负责人 origin/*');
  assert.throws(() => f.view.update(sim.state, '__proto__'), /未知的仓库身份/);
  assert.deepEqual(f.rows(), [['dev', 'C2', '尚未获取未同步'], ['main', 'C2', 'C2']]);
  assert.equal(integrator.tracking.dev, undefined);
  assert.equal(integrator.execute(sim, 'git fetch').ok, true);
  f.view.update(integrator.commandContext(sim).state, 'integrator');
  assert.deepEqual(f.rows(), [['dev', 'C2', 'C2'], ['main', 'C2', 'C2']]);
  assert.equal(integrator.branches.dev, undefined);
  f.view.update(peer.commandContext(sim).state, 'remote');
  assert.deepEqual(f.rows(), [['dev', 'C2', '尚未获取未同步'], ['main', 'C2', 'C2']]);
  assert.equal(peer.tracking.dev, undefined); assert.equal(peer.branches.dev, undefined);
  assert.equal(peer.execute(sim, 'git fetch').ok, true); f.view.update(peer.commandContext(sim).state, 'remote');
  assert.deepEqual(f.rows(), [['dev', 'C2', 'C2'], ['main', 'C2', 'C2']]); assert.equal(peer.branches.dev, undefined);
});

test('无远程或历史残留的跟踪引用明确显示，不读取继承属性冒充提交', () => {
  const state = new Simulator().snapshot(), f = fixture(); state.remote.branches = {}; state.tracking = {};
  f.view.update(state); assert.deepEqual(f.rows(), [['暂无远程分支或跟踪记录。']]);
  state.tracking.toString = 'C0'; f.view.update(state);
  assert.deepEqual(f.rows(), [['toString', '不存在', 'C0未同步']]);
  state.tracking = {}; state.remote.branches.constructor = 'C1'; f.view.update(state);
  assert.deepEqual(f.rows(), [['constructor', 'C1', '尚未获取未同步']]);
});

test('长分支、中文和 HTML 文本只作为文字显示，折叠区不创建命令操作入口', () => {
  const state = new Simulator().snapshot(), f = fixture(), name = '<img-src=x>' + '很长的分支'.repeat(12);
  state.remote.branches = { [name]: 'C2' }; state.tracking = {};
  f.view.update(state); const branch = f.view.rows.children[0].children[0];
  assert.equal(branch.textContent, name); assert.equal(branch.children.length, 0);
  const all = item => [item, ...item.children.flatMap(all)];
  assert.equal(all(f.panel).filter(item => ['button', 'select', 'img', 'script'].includes(item.tagName)).length, 0);
});
