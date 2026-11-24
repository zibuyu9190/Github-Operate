const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Simulator, RemoteWorkspace, SCENES } = require('../simulator.js');
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

test('九场景均有答案，全部参考命令可解析，起点不误判完成，验收保持状态只读', () => {
  assert.equal(Object.keys(SCENES).length, 9);
  assert.deepEqual(Object.keys(LESSONS), Object.keys(SCENES));
  for (const [scene, lesson] of Object.entries(LESSONS)) for (const route of lesson.routes) {
    for (const step of route.steps) if (step.command) assert.doesNotThrow(() => parse(step.command));
    const f = fixture(scene, route.id), before = f.sim.snapshot();
    assert.equal(f.result().complete, false, scene + '/' + route.id); assert.deepEqual(f.sim.snapshot(), before);
  }
});

test('逐条执行界面中的完整参考步骤，九场景所有方案均能达标', () => {
  for (const [scene, lesson] of Object.entries(LESSONS)) for (const route of lesson.routes) {
    const f = fixture(scene, route.id);
    const tip = f.sim.state.remote.branches.main;
    const remote = tip ? new RemoteWorkspace('main', f.sim.state.remote.commits[tip], f.sim.state.remote) : null;
    for (let n = 0; n < route.steps.length; n++) {
      const step = route.steps[n];
      if (step.command) {
        const result = step.actor === 'remote' ? remote.execute(f.sim, step.command) : f.sim.execute(step.command);
        f.practice.record(result);
        if ((scene === 'remote' && n === 0) || (scene === 'collab' && n === 7)) {
          assert.equal(result.ok, false); assert.match(result.output, /non-fast-forward/);
        } else {
          assert.equal(result.ok, true, scene + '/' + route.id + ': ' + step.command + ': ' + result.output);
        }
      } else {
        const target = step.actor === 'remote' ? remote : f.sim;
        const file = step.file || 'hello.txt';
        const baseText = (step.actor === 'remote' ? remote.work[file] : f.sim.state.work[file]) || '';
        const nextText = step.append ? baseText + (step.content.endsWith('\n') ? step.content : step.content + '\n') : step.content;
        target.editFile(file, nextText);
      }
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

test('暂存与修订：stash-amend 缺少 --amend 或未 pop 不达标，restore 用错命令也不达标', () => {
  const f = fixture('stash', 'stash-amend');
  f.run('git stash push -u -m "dev"');
  f.run('git switch main');
  f.sim.editFile('README.md', f.sim.state.work['README.md'] + '修复说明\n');
  f.run('git add README.md');
  f.run('git commit -m "fix"');
  f.run('git switch feature');
  f.run('git stash pop');
  f.run('git add .');
  f.run('git commit -m "feature done"');
  assert.equal(f.result().checks[1].passed, false);
  assert.equal(f.result().complete, false);

  const wrongRestore = fixture('stash', 'restore');
  wrongRestore.run('git stash push -u');
  assert.equal(wrongRestore.result().checks[1].passed, false);
  assert.equal(wrongRestore.result().complete, false);
});

test('摘取与救援：merge 不能冒充 cherry-pick、未打 tag 不通过；revert-reflog 缺 reflog 不通过', () => {
  const merged = fixture('rescue', 'cherry-pick');
  merged.run('git merge experiment');
  merged.run('git tag v1.1');
  assert.equal(merged.result().checks[0].passed, false);
  assert.equal(merged.result().complete, false);

  const noTag = fixture('rescue', 'cherry-pick');
  noTag.run('git cherry-pick experiment');
  assert.equal(noTag.result().checks[0].passed, true);
  assert.equal(noTag.result().checks[2].passed, false);
  assert.equal(noTag.result().complete, false);

  const noReflog = fixture('rescue', 'revert-reflog');
  noReflog.run('git revert HEAD');
  assert.equal(noReflog.result().checks[0].passed, true);
  assert.equal(noReflog.result().checks[1].passed, false);
  assert.equal(noReflog.result().complete, false);

  // 原地 reset --hard HEAD（HEAD 未离开反向提交）再 reflog + branch 不能绕过误删演练
  const inPlace = fixture('rescue', 'revert-reflog');
  inPlace.run('git revert HEAD');
  inPlace.run('git reset --hard HEAD');
  inPlace.run('git reflog');
  inPlace.run('git branch rescue HEAD');
  assert.equal(inPlace.result().checks[1].passed, false);
  assert.equal(inPlace.result().checks[2].passed, false);
  assert.equal(inPlace.result().checks[3].passed, false);
  assert.equal(inPlace.result().complete, false);

  // 先提前建 rescue 分支再丢弃并切回，也不算通过 reflog 救回
  const premature = fixture('rescue', 'revert-reflog');
  premature.run('git revert HEAD');
  premature.run('git branch rescue HEAD');
  premature.run('git reset --hard HEAD~2');
  premature.run('git reflog');
  premature.run('git reset --hard rescue');
  assert.equal(premature.result().checks[1].passed, true);
  assert.equal(premature.result().checks[2].passed, false);
  assert.equal(premature.result().complete, false);
});

test('reflog 救援：其他分支的原地 reset 不算 main 丢失反向提交', () => {
  const f = fixture('rescue', 'revert-reflog');
  f.run('git revert HEAD');
  const reverted = f.sim.state.branches.main;
  f.run('git branch side HEAD~2');
  f.run('git switch side');
  f.run('git reset --hard HEAD');
  f.run('git reflog');
  f.run('git branch rescue main');
  f.run('git switch main');

  assert.equal(f.sim.state.branches.main, reverted);
  assert.equal(f.result().checks[1].passed, false);
  assert.equal(f.result().checks[2].passed, false);
  assert.equal(f.result().complete, false);
});

test('reflog 救援：查阅记录之前创建的分支不能事后计为救援', () => {
  const f = fixture('rescue', 'revert-reflog');
  f.run('git revert HEAD');
  f.run('git reset --hard HEAD~2');
  f.run('git branch premature HEAD@{1}');
  f.run('git reflog');
  assert.equal(f.result().checks[1].passed, true);
  assert.equal(f.result().checks[2].passed, false);

  // 改名也不能把提前创建的分支变成查阅 reflog 后的新分支。
  f.run('git branch -m premature renamed');
  assert.equal(f.result().checks[2].passed, false);
  assert.equal(f.result().complete, false);

  f.run('git branch recovery HEAD@{1}');
  f.run('git branch -m recovery saved-recovery');
  f.run('git reset --hard saved-recovery');
  f.pass();
});

test('双人协作：合并负责人的推送与冲突不计入验收，开发身份仍可推进验收', () => {
  const f = fixture('collab', 'collab-conflict');
  const origin = f.sim.state.remote;
  const start = origin.commits[origin.branches.main];
  const integrator = new RemoteWorkspace('main', start, origin, 'integrator');
  const collaborator = new RemoteWorkspace('main', start, origin);
  const execute = (workspace, command) => {
    const result = workspace.execute(f.sim, command);
    assert.ok(result.ok, result.output);
    f.practice.record(result);
    return result;
  };

  integrator.editFile('hello.txt', '合并负责人改动\n');
  execute(integrator, 'git add hello.txt');
  execute(integrator, 'git commit -m "负责人更新"');
  execute(integrator, 'git push');
  assert.equal(f.sim.state.remote.branches.main, integrator.baseId);
  assert.equal(f.result().checks[0].passed, false);

  execute(collaborator, 'git fetch origin');
  execute(collaborator, 'git merge origin/main');
  collaborator.editFile('hello.txt', '协作者改动\n');
  execute(collaborator, 'git add hello.txt');
  execute(collaborator, 'git commit -m "协作者更新"');
  execute(collaborator, 'git push');
  assert.equal(f.result().checks[0].passed, true);

  integrator.editFile('hello.txt', '负责人另有改动\n');
  execute(integrator, 'git add hello.txt');
  execute(integrator, 'git commit -m "负责人另有改动"');
  execute(integrator, 'git fetch origin');
  assert.equal(execute(integrator, 'git merge origin/main').conflict, true);
  assert.equal(f.practice.sawConflict, false);
  assert.equal(f.result().checks[1].passed, false);
  assert.equal(f.result().complete, false);
});

test('双人协作：协作者推前、本地未推送、abort 后提交无关文件均不通过；merge/rebase 解决冲突后通过', () => {
  const f = fixture('collab', 'collab-conflict');
  const tip = f.sim.state.remote.branches.main;
  const remote = new RemoteWorkspace('main', f.sim.state.remote.commits[tip], f.sim.state.remote);
  const runRemote = cmd => { const r = remote.execute(f.sim, cmd); f.practice.record(r); assert.equal(r.ok, true, r.output); return r; };

  remote.editFile('hello.txt', '协作者修改\n保留这一行作为共同上下文。\n');
  runRemote('git add hello.txt');
  runRemote('git commit -m "peer commit"');
  assert.equal(f.result().checks[0].passed, false);
  runRemote('git push');
  assert.equal(f.result().checks[0].passed, true);
  assert.equal(f.result().complete, false);

  f.sim.editFile('hello.txt', '本地修改\n保留这一行作为共同上下文。\n');
  f.run('git add hello.txt');
  f.run('git commit -m "local commit"');
  f.run('git fetch origin');
  const pullConflict = f.run('git pull --no-rebase origin main');
  assert.equal(pullConflict.conflict, true);
  assert.equal(f.result().checks[1].passed, true);
  f.sim.editFile('hello.txt', '整合双方内容\n保留这一行作为共同上下文。\n');
  f.run('git add hello.txt');
  f.run('git merge --continue');
  assert.equal(f.result().checks[2].passed, true);
  assert.equal(f.result().checks[3].passed, false);
  assert.equal(f.result().complete, false);

  f.run('git push');
  f.pass();

  // 触发冲突后 abort 并 reset --hard origin/main 再提交无关文件推送，不能冒充解决冲突
  const bypassed = fixture('collab', 'collab-conflict');
  const peerTip = bypassed.sim.state.remote.branches.main;
  const peer = new RemoteWorkspace('main', bypassed.sim.state.remote.commits[peerTip], bypassed.sim.state.remote);
  peer.editFile('hello.txt', '协作者版本\n保留这一行作为共同上下文。\n');
  for (const cmd of ['git add hello.txt', 'git commit -m "peer"', 'git push']) {
    const r = peer.execute(bypassed.sim, cmd); bypassed.practice.record(r); assert.equal(r.ok, true, r.output);
  }
  bypassed.sim.editFile('hello.txt', '本地冲突提交\n保留这一行作为共同上下文。\n');
  bypassed.run('git add hello.txt');
  bypassed.run('git commit -m "local conflict"');
  bypassed.run('git fetch origin');
  assert.equal(bypassed.run('git pull --no-rebase origin main').conflict, true);
  bypassed.run('git merge --abort');
  bypassed.run('git reset --hard origin/main');
  bypassed.sim.editFile('other.txt', '无关提交\n');
  bypassed.run('git add other.txt');
  bypassed.run('git commit -m "unrelated commit"');
  bypassed.run('git push');
  assert.equal(bypassed.result().checks[2].passed, false);
  assert.equal(bypassed.result().checks[3].passed, false);
  assert.equal(bypassed.result().complete, false);

  // 通过 git pull --rebase 触发冲突并解决后也能通过验收
  const rebased = fixture('collab', 'collab-conflict');
  const peerR = new RemoteWorkspace('main', rebased.sim.state.remote.commits[rebased.sim.state.remote.branches.main], rebased.sim.state.remote);
  peerR.editFile('hello.txt', '协作者版本\n保留这一行作为共同上下文。\n');
  for (const cmd of ['git add hello.txt', 'git commit -m "peer rebase"', 'git push']) {
    const r = peerR.execute(rebased.sim, cmd); rebased.practice.record(r); assert.equal(r.ok, true, r.output);
  }
  rebased.sim.editFile('hello.txt', '本地变基提交\n保留这一行作为共同上下文。\n');
  rebased.run('git add hello.txt');
  rebased.run('git commit -m "local rebase"');
  assert.equal(rebased.run('git pull --rebase origin main').conflict, true);
  rebased.sim.editFile('hello.txt', '变基整合版本\n保留这一行作为共同上下文。\n');
  rebased.run('git add hello.txt');
  rebased.run('git rebase --continue');
  rebased.run('git push');
  rebased.pass();
});
