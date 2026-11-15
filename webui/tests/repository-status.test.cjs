const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator } = require('../simulator.js');
const { repositorySummary, StatusView } = require('../graph-viewer.js').RepositoryBrowser;

function run(sim, command) { const result = sim.execute(command); assert.equal(result.ok, true, result.output); return result; }
function commit(sim, path, text) { sim.editFile(path, text); run(sim, 'git add .'); run(sim, 'git commit -m "更新文件"'); }

test('推送同名分支不等于设置上游，-u 后才显示同步数量；查询保持仓库只读', () => {
  const sim = new Simulator(); run(sim, 'git switch -c feature');
  run(sim, 'git push origin feature');
  assert.equal(sim.state.tracking.feature, sim.headId());
  assert.equal(repositorySummary(sim.state).mode, 'unset');
  assert.equal(repositorySummary(sim.state).ahead, null);
  run(sim, 'git push -u origin feature');
  const before = sim.snapshot(), result = repositorySummary(sim.state);
  assert.equal(result.upstream, 'feature'); assert.equal(result.mode, 'ready');
  assert.equal(result.ahead, 0); assert.equal(result.behind, 0);
  assert.deepEqual(sim.snapshot(), before);
});

test('协作者提交不提前更新数量，fetch 后显示分叉，合并与 push 后数量准确', () => {
  const sim = new Simulator();
  commit(sim, 'local.txt', '我的提交\n');
  assert.equal(repositorySummary(sim.state).ahead, 1); assert.equal(repositorySummary(sim.state).behind, 0);
  sim.simulateRemote();
  assert.equal(repositorySummary(sim.state).behind, 0);
  run(sim, 'git fetch');
  assert.equal(repositorySummary(sim.state).ahead, 1); assert.equal(repositorySummary(sim.state).behind, 1);
  run(sim, 'git merge origin/main');
  assert.equal(repositorySummary(sim.state).ahead, 2); assert.equal(repositorySummary(sim.state).behind, 0);
  run(sim, 'git push');
  assert.equal(repositorySummary(sim.state).ahead, 0); assert.equal(repositorySummary(sim.state).behind, 0);
});

test('分离 HEAD、不同名上游、丢失跟踪引用和缺失本地对象不伪造同步结果', () => {
  const sim = new Simulator(); run(sim, 'git switch -c dev');
  sim.state.upstreams.dev = 'main';
  assert.equal(repositorySummary(sim.state).upstream, 'main');
  sim.simulateRemote(); const tip = sim.state.remote.branches.main;
  sim.state.tracking.main = tip;
  assert.equal(repositorySummary(sim.state).mode, 'unavailable');
  assert.equal(repositorySummary(sim.state).behind, null);
  run(sim, 'git fetch'); assert.equal(repositorySummary(sim.state).behind, 1);
  delete sim.state.commits.C0;
  assert.equal(repositorySummary(sim.state).mode, 'unavailable');
  const fresh = new Simulator(); delete fresh.state.tracking.main;
  assert.equal(repositorySummary(fresh.state).mode, 'unavailable');
  run(fresh, 'git checkout C0');
  assert.equal(repositorySummary(fresh.state).mode, 'detached'); assert.equal(repositorySummary(fresh.state).upstream, null);
});

test('Stash 计数覆盖多份保存、apply 保留、pop 移除、drop、clear 和场景重置', () => {
  const sim = new Simulator();
  assert.equal(repositorySummary(sim.state).stashes, 0);
  sim.editFile('hello.txt', '第一份\n'); run(sim, 'git stash push');
  sim.editFile('hello.txt', '第二份\n'); run(sim, 'git stash push');
  assert.equal(repositorySummary(sim.state).stashes, 2);
  run(sim, 'git stash apply'); assert.equal(repositorySummary(sim.state).stashes, 2);
  run(sim, 'git restore .'); run(sim, 'git stash pop'); assert.equal(repositorySummary(sim.state).stashes, 1);
  run(sim, 'git stash drop'); assert.equal(repositorySummary(sim.state).stashes, 0);
  run(sim, 'git stash push'); run(sim, 'git stash clear'); assert.equal(repositorySummary(sim.state).stashes, 0);
  sim.editFile('hello.txt', '刷新前\n'); run(sim, 'git stash push'); sim.loadScene('branches');
  assert.equal(repositorySummary(sim.state).stashes, 0);
});

test('Stash 跨分支恢复冲突时记录仍保留，计数与 HEAD、上游身份各自独立', () => {
  const sim = new Simulator(); run(sim, 'git branch feature');
  sim.editFile('hello.txt', '保存内容\n'); run(sim, 'git stash push');
  run(sim, 'git switch feature'); commit(sim, 'hello.txt', '另一分支内容\n');
  assert.equal(run(sim, 'git stash pop').conflict, true);
  const summary = repositorySummary(sim.state);
  assert.equal(summary.stashes, 1); assert.equal(summary.branch, 'feature'); assert.equal(summary.mode, 'unset');
});

/** 小型 DOM 只检查状态展示与事件副作用，实际布局和焦点定位通过浏览器验证。 */
function fixture() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, action) { this.events[name] = action; }
    after(item) { this.next = item; }
  }
  const heading = new Element('header'), panel = new Element('section'); panel.querySelector = () => heading;
  const animations = []; panel.animate = (frames, options) => { const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(animation); return animation; };
  const commands = [], old = global.document; global.document = { createElement: tag => new Element(tag) };
  let view;
  try { view = new StatusView(panel, command => commands.push(command)); } finally { global.document = old; }
  return { view, heading, commands, animations };
}

test('常驻状态明确标记本地仓库，Stash 点击只填命令，长分支与文本不作为 HTML 执行', () => {
  const f = fixture(), sim = new Simulator();
  const before = sim.snapshot(); f.view.update(sim.state);
  assert.equal(f.heading.next, f.view.root);
  assert.match(f.view.upstream.textContent, /origin\/main.*领先 0.*落后 0/);
  assert.equal(f.view.stash.textContent, '本地 Stash：0');
  f.view.stash.events.click(); assert.deepEqual(f.commands, ['git stash list']); assert.deepEqual(sim.snapshot(), before);
  const state = sim.snapshot(), name = '<img-src=x>';
  state.head.branch = name; state.branches[name] = 'C0'; f.view.update(state);
  assert.equal(f.view.branch.textContent, '分支：' + name); assert.equal(f.view.branch.children.length, 0);
  assert.equal(f.view.upstream.textContent, '上游：未设置'); assert.match(f.view.sync.textContent, /git push -u origin/);
  state.head = { branch: null, id: 'C0' }; f.view.update(state);
  assert.match(f.view.branch.textContent, /分离 HEAD/); assert.doesNotMatch(f.view.sync.textContent, /领先 0/);
  state.head.branch = 'main'; delete state.tracking.main; f.view.update(state);
  assert.match(f.view.sync.textContent, /无法计算/);
});

test('协作者定位高亮支持重复点击且不改变仓库，减少动画设置会取消正在播放的高亮', () => {
  const f = fixture(), sim = new Simulator(), before = sim.snapshot();
  const old = global.matchMedia; let reduced = false; global.matchMedia = () => ({ matches: reduced });
  try {
    f.view.update(sim.state); f.view.highlightCollaborator();
    assert.equal(f.animations.length, 1);
    f.view.highlightCollaborator(); assert.equal(f.animations[0].cancelled, true); assert.equal(f.animations.length, 2);
    reduced = true; f.view.highlightCollaborator();
    assert.equal(f.animations[1].cancelled, true); assert.equal(f.animations.length, 2);
    assert.deepEqual(sim.snapshot(), before);
  } finally { global.matchMedia = old; }
});
