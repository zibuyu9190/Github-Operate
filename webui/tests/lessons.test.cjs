const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, SCENES } = require('../simulator.js');
const { LESSONS, Practice } = require('../lessons.js');
const { parse } = require('../commands.js');

function fixture(scene, route) {
  const sim = new Simulator(scene), practice = new Practice(scene, sim.snapshot(), route);
  const run = text => {
    const result = sim.execute(text); practice.record(result);
    assert.equal(result.ok, true, text + ': ' + result.output);
    return result;
  };
  const result = dirty => practice.evaluate(sim.state, dirty);
  const pass = () => assert.equal(result().complete, true, JSON.stringify(result().checks));
  return { sim, practice, run, result, pass };
}

test('六场景均有答案，全部参考命令可解析，起点不误判完成，验收保持状态只读', () => {
  assert.deepEqual(Object.keys(LESSONS), Object.keys(SCENES));
  for (const [scene, lesson] of Object.entries(LESSONS)) for (const route of lesson.routes) {
    for (const step of route.steps) if (step.command) assert.doesNotThrow(() => parse(step.command));
    const f = fixture(scene, route.id), before = f.sim.snapshot();
    assert.equal(f.result().complete, false, scene + '/' + route.id); assert.deepEqual(f.sim.snapshot(), before);
  }
});

test('逐条执行界面中的完整参考步骤，六场景所有方案均能达标', () => {
  for (const [scene, lesson] of Object.entries(LESSONS)) for (const route of lesson.routes) {
    const f = fixture(scene, route.id);
    for (let n = 0; n < route.steps.length; n++) {
      const step = route.steps[n];
      if (step.command) {
        const result = f.sim.execute(step.command); f.practice.record(result);
        if (scene === 'remote' && n === 0) { assert.equal(result.ok, false); assert.match(result.output, /non-fast-forward/); }
        else assert.equal(result.ok, true, scene + '/' + route.id + ': ' + step.command + ': ' + result.output);
      } else f.sim.editFile('hello.txt', scene === 'basic' ? f.sim.state.work['hello.txt'] + step.content + '\n' : step.content);
    }
    f.pass();
  }
});

test('基础提交：只编辑、只 add、提交其他文件均不算完成，接受自定义内容与说明', () => {
  const f = fixture('basic'); f.sim.editFile('other.txt', 'other\n'); f.run('git add .'); f.run('git commit -m "other"');
  assert.equal(f.result().complete, false);
  f.sim.editFile('hello.txt', '我的答案\n'); assert.equal(f.result().complete, false);
  f.run('git add hello.txt'); assert.equal(f.result().complete, false); f.run('git commit -m "自定义说明"'); f.pass();
  assert.equal(f.result(true).complete, false);
  f.sim.editFile('hello.txt', '后续修改\n'); assert.equal(f.result().complete, false);
});

test('分支整合：merge 与 rebase 两条完整路径均通过，各路径有独立拓扑要求', () => {
  for (const route of LESSONS.branches.routes) {
    const f = fixture('branches', route.id);
    for (const step of route.steps) f.run(step.command);
    f.pass();
    f.run('git branch -d bugFix');
    f.pass();
    f.practice.route = route.id === 'merge' ? 'rebase' : 'merge';
    assert.equal(f.result().complete, false);
  }
  const f = fixture('branches'); f.run('git reset --hard bugFix'); assert.equal(f.result().complete, false);
});

test('分支整合：rebase 路线删除分支后仍要求实际变基，摘取提交不能代替', () => {
  const f = fixture('branches', 'rebase');
  f.run('git cherry-pick bugFix');
  f.run('git switch bugFix');
  f.run('git reset --hard main');
  f.run('git switch main');
  f.run('git branch -d bugFix');
  assert.equal(f.result().complete, false);
});

test('冲突：触发、编辑、add、continue 分阶段检查，保留任一方也是有效解决', () => {
  for (const content of ['自定义整合结果\n', new Simulator('conflict').headTree()['hello.txt']]) {
    const f = fixture('conflict'); assert.equal(f.run('git merge bugFix').conflict, true);
    assert.equal(f.result().complete, false); assert.equal(f.result().checks[1].passed, false);
    f.sim.editFile('hello.txt', content); assert.equal(f.result().checks[1].passed, false);
    f.run('git add hello.txt'); assert.equal(f.result().checks[1].passed, true); assert.equal(f.result().complete, false);
    f.run('git merge --continue'); f.pass();
  }
});

test('冲突：未删标记却 add/commit 以及 abort 均不算完成', () => {
  const f = fixture('conflict'); f.run('git merge bugFix'); f.run('git add .'); f.run('git merge --continue');
  assert.equal(f.result().complete, false); assert.equal(f.result().checks[1].passed, false);
  const aborted = fixture('conflict'); aborted.run('git merge bugFix'); aborted.run('git merge --abort'); assert.equal(aborted.result().complete, false);
});

test('变基：新提交与原 main 的父链可验收，merge/reset 不能冒充完成', () => {
  const f = fixture('rebase'); f.run('git rebase main'); f.pass();
  const merged = fixture('rebase'); merged.run('git merge main'); assert.equal(merged.result().complete, false);
  const reset = fixture('rebase'); reset.run('git reset --hard main'); assert.equal(reset.result().complete, false);
});

test('Reset：三种模式分别通过，错误模式、连续多退一次及手工篡改状态均不通过', () => {
  for (const route of LESSONS.reset.routes) {
    const f = fixture('reset', route.id); f.run('git reset --' + route.id + ' HEAD~1'); f.pass();
    f.practice.route = route.id === 'soft' ? 'mixed' : 'soft'; assert.equal(f.result().complete, false);
    f.practice.route = route.id; f.run('git reset --' + route.id + ' HEAD~1'); assert.equal(f.result().complete, false);
  }
  const f = fixture('reset', 'hard'), target = f.sim.resolve('HEAD~1');
  f.sim.state.branches.main = target; f.sim.installTree(f.sim.headTree()); assert.equal(f.result().complete, false);
});

test('远程：预期 push 拒绝、只 fetch 或只 pull 均不完成，两种整合后 push 可完成', () => {
  for (const route of LESSONS.remote.routes) {
    const f = fixture('remote', route.id), before = f.sim.snapshot();
    const rejected = f.sim.execute('git push'); f.practice.record(rejected); assert.equal(rejected.ok, false); assert.deepEqual(f.sim.snapshot(), before);
    assert.equal(f.result().complete, false); f.run('git fetch origin'); assert.equal(f.result().complete, false);
    f.run('git pull ' + (route.id === 'merge' ? '--no-rebase' : '--rebase') + ' origin main'); assert.equal(f.result().complete, false);
    f.run('git push'); f.pass();
    f.sim.simulateRemote(); assert.equal(f.result().complete, false);
  }
});

test('重置或切换场景重新绑定基线，丢弃之前的冲突证据与完成结果', () => {
  const f = fixture('conflict'); f.run('git merge bugFix'); f.sim.loadScene('conflict');
  const fresh = new Practice('conflict', f.sim.snapshot()); assert.equal(fresh.sawConflict, false); assert.equal(fresh.evaluate(f.sim.state).complete, false);
  const reset = fixture('reset', 'mixed'); reset.run('git reset --mixed HEAD~1'); reset.pass(); reset.sim.loadScene('reset');
  const restarted = new Practice('reset', reset.sim.snapshot(), 'mixed'); assert.equal(restarted.route, 'mixed'); assert.equal(restarted.evaluate(reset.sim.state).complete, false);
});
