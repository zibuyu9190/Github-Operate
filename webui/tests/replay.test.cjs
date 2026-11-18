const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Simulator } = require('../simulator.js');

/** 执行实际回放控制代码，用可推进的时钟检验完整生命周期，不等待真实秒数。 */
function fixture({ reduced = false, collaborator = false } = {}) {
  const sim = new Simulator('reset'), result = sim.execute('git reset --mixed HEAD~1');
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
      hidden: false, textContent: '', disabled: false, attributes: {},
      classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: name => classes.has(name) },
      style: { setProperty(name, value) { this[name] = value; } },
      setAttribute(name, value) { this.attributes[name] = value; },
      after(item) { elements.set(item.id, item); }
    };
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const body = element(), panel = element();
  const context = vm.createContext({
    $, node: () => element(), document: { body }, filePanel: panel,
    lastResult: result, replayTimer: null, graphState: () => current,
    graph: { draw: (state, options) => draws.push({ state: structuredClone(state), options: options && { ...options } }) },
    animateFiles: value => { fileAnimations.push(value); panel.classList.add('file-flowing'); },
    matchMedia: () => ({ matches: reduced }),
    performance: { now: () => clock },
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { at: clock + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const start = app.indexOf('  const REPLAY_BEFORE_MS'), end = app.indexOf('\n  Object.entries(SCENES)', start);
  assert.ok(start > 0 && end > start, '回放代码必须存在');
  vm.runInContext(app.slice(start, end) + '\nglobalThis.controls = { replay, cancelReplay };', context);
  function advance(ms) {
    const end = clock + ms;
    while (timers.size) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (timer.at > end) break;
      clock = Math.max(clock, timer.at); timers.delete(id); timer.fn();
    }
    clock = end;
  }
  return { ...context.controls, context, $, body, panel, draws, fileAnimations, timers, result, current, saved, advance, elapse: ms => { clock += ms; } };
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
  assert.equal(f.body.classList.contains('replay-active'), false);
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

test('协作者回放使用协作者快照，缺少成功结果时不启动', () => {
  const f = fixture({ collaborator: true }); f.replay();
  assert.deepEqual(f.draws.at(-1).state, f.result.graphBefore);
  f.advance(2500); assert.deepEqual(f.draws.at(-1).state, f.result.graphAfter);
  f.cancelReplay(); assert.deepEqual(f.draws.at(-1).state, f.current);
  f.context.lastResult = null; const count = f.draws.length; f.replay();
  assert.equal(f.draws.length, count); assert.equal(f.timers.size, 0);
});
