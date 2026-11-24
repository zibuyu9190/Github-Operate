const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, RemoteWorkspace } = require('../simulator.js');
const { ReplayController } = require('../replay.js');

/** 执行实际回放控制器，用可推进的时钟检验完整生命周期，不等待真实秒数。 */
function fixture({ reduced = false, collaborator = false, initialResult = null } = {}) {
  let result = initialResult;
  if (!result) {
    const sim = new Simulator('reset');
    result = sim.execute('git reset --mixed HEAD~1');
  }
  if (collaborator) {
    result.graphBefore = structuredClone(result.before); result.graphAfter = structuredClone(result.after);
    result.graphBefore.branches = { dev: 'C2' }; result.graphBefore.head.branch = 'dev';
    result.graphAfter.branches = { dev: 'C1' }; result.graphAfter.head.branch = 'dev';
  }
  const current = result.graphAfter || result.after, saved = structuredClone(current);
  const elements = new Map(), timers = new Map(), draws = [], fileAnimations = [];
  let clock = 0, nextId = 1;
  function element() {
    const classes = new Set();
    return {
      hidden: false, textContent: '', disabled: false, title: '', attributes: {},
      classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: name => classes.has(name) },
      style: { setProperty(name, value) { this[name] = value; } },
      setAttribute(name, value) { this.attributes[name] = value; }
    };
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const panel = $('file-panel');
  const controller = new ReplayController({
    button: $('replay'),
    stage: $('graph-stage'),
    status: $('replay-status'),
    flow: $('flow'),
    filePanel: panel,
    graph: { draw: (state, options) => draws.push({ state: structuredClone(state), options: options && { ...options } }) },
    getState: () => current,
    animateFiles: value => { fileAnimations.push(value); panel.classList.add('file-flowing'); },
    matchMedia: () => ({ matches: reduced }),
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { at: clock + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  controller.setResult(result);
  function advance(ms) {
    const end = clock + ms;
    while (timers.size) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (timer.at > end) break;
      clock = Math.max(clock, timer.at); timers.delete(id); timer.fn();
    }
    clock = end;
  }
  return {
    controller,
    replay: () => controller.replay(),
    cancelReplay: () => controller.cancel(),
    $, panel, draws, fileAnimations, timers, result, current, saved, advance, elapse: ms => { clock += ms; }
  };
}

test('只在变化前保持 2.5 秒，显示结果后立即结束，按钮不标注时间', () => {
  const f = fixture(); f.panel.classList.add('file-flowing'); f.$('flow').classList.add('flash'); f.replay();
  assert.deepEqual(f.draws[0].state, f.result.before);
  assert.match(f.$('replay-status').textContent, /变化前状态/);
  assert.equal(f.panel.classList.contains('file-flowing'), false);
  assert.equal(f.$('flow').classList.contains('flash'), false);
  assert.equal(f.$('replay').disabled, false); // 播放时仍可停止。
  f.advance(2499); assert.equal(f.draws.length, 1);
  assert.equal(f.$('replay-status').hidden, false);
  f.advance(1); assert.deepEqual(f.draws[1].state, f.result.after);
  assert.equal(f.draws[1].options.animate, true);
  assert.equal(f.draws[1].options.animationDuration, undefined);
  assert.equal(f.fileAnimations.length, 1);
  assert.equal(f.draws.length, 2);
  assert.equal(f.$('replay-status').hidden, true);
  assert.equal(f.$('replay').attributes['aria-pressed'], 'false');
  assert.equal(f.$('replay').textContent, '▷ 重播变化');
  assert.equal(f.$('replay').disabled, false);
  assert.equal(f.$('graph-stage').classList.contains('replaying'), false);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.current, f.saved);
  f.advance(10000); assert.equal(f.draws.length, 2);
});

for (const elapsed of [500, 1500, 2499]) test('在第 ' + elapsed + ' 毫秒取消后恢复当前视图，旧回调不会覆盖新场景', () => {
  const f = fixture(); f.replay(); f.advance(elapsed); f.cancelReplay();
  assert.deepEqual(f.draws.at(-1).state, f.current);
  assert.equal(f.$('graph-stage').classList.contains('replaying'), false);
  assert.equal(f.panel.classList.contains('file-flowing'), false);
  assert.equal(f.$('replay-status').hidden, true);
  const count = f.draws.length; f.advance(20000);
  assert.equal(f.draws.length, count); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.current, f.saved);
});

test('重复点击先停止，再次点击从起点完整播放', () => {
  const f = fixture(); f.replay(); f.advance(1000); f.replay();
  assert.equal(f.timers.size, 0); assert.deepEqual(f.draws.at(-1).state, f.current);
  f.replay(); assert.deepEqual(f.draws.at(-1).state, f.result.before);
  f.advance(10000); assert.equal(f.timers.size, 0);
});

test('减少动画只关闭运动效果，保留变化前 2.5 秒观察时间', () => {
  const f = fixture({ reduced: true }); f.replay();
  assert.deepEqual(f.draws.at(-1).state, f.result.before);
  f.advance(2499); assert.equal(f.draws.length, 1);
  f.advance(1); assert.deepEqual(f.draws.at(-1).state, f.result.after);
  assert.equal(f.draws.at(-1).options.animate, false);
  assert.equal(f.fileAnimations.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.$('replay-status').hidden, true); assert.deepEqual(f.current, f.saved);
});

test('后台延迟回调恢复时直接显示到期结果，不补等也不增加结果停留', () => {
  const f = fixture(); f.replay(); f.elapse(7000); f.advance(0);
  assert.deepEqual(f.draws.at(-1).state, f.result.after);
  assert.equal(f.$('replay-status').hidden, true);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.current, f.saved);
});

test('协作者回放使用协作者快照，缺少结果或 reset 后禁用重播', () => {
  const f = fixture({ collaborator: true }); f.replay();
  assert.deepEqual(f.draws.at(-1).state, f.result.graphBefore);
  f.advance(2500); assert.deepEqual(f.draws.at(-1).state, f.result.graphAfter);
  f.cancelReplay(); assert.deepEqual(f.draws.at(-1).state, f.current);
  f.controller.reset();
  assert.equal(f.$('replay').disabled, true);
  const count = f.draws.length; f.replay();
  assert.equal(f.draws.length, count); assert.equal(f.timers.size, 0);
});

test('git pull fetch 完成后整合抛错时，仍支持记录并重播拉取变化', () => {
  const sim = new Simulator('basic');
  sim.editFile('docs', '本地同名文件\n');
  assert.equal(sim.execute('git add .').ok, true);
  assert.equal(sim.execute('git commit -m "本地添加 docs 文件"').ok, true);
  const draft = new RemoteWorkspace('main', sim.state.remote.commits[sim.state.remote.branches.main], sim.state.remote);
  draft.editFile('docs/guide.txt', '协作者添加目录文件\n');
  assert.equal(draft.execute(sim, 'git add .').ok, true);
  assert.equal(draft.execute(sim, 'git commit -m "协作者添加 docs/guide.txt"').ok, true);
  assert.equal(draft.execute(sim, 'git push').ok, true);
  const pullResult = sim.execute('git pull');
  assert.equal(pullResult.ok, false);
  assert.equal(pullResult.fetchCompleted, true);
  assert.notEqual(pullResult.after.tracking.main, pullResult.before.tracking.main);

  const f = fixture({ initialResult: pullResult });
  assert.equal(f.$('replay').disabled, false);
  f.replay();
  assert.deepEqual(f.draws[0].state, pullResult.before);
  f.advance(2500);
  assert.deepEqual(f.draws[1].state, pullResult.after);
});
