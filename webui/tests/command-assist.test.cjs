const { test } = require('node:test');
const assert = require('node:assert/strict');
const { complete, recommend, usage, Controller } = require('../command-assist.js');
const { parse } = require('../commands.js');
const { Simulator, RemoteWorkspace } = require('../simulator.js');

const context = sim => ({ state: sim.state, files: sim.fileStatus(), scene: sim.scene });
const suggestions = (sim, text, caret = text.length) => complete(text, caret, context(sim));
const commands = sim => recommend(context(sim)).map(row => row.command);
const run = (sim, text) => assert.equal(sim.execute(text).ok, true, text);

test('补全支持带 git 前缀与省略前缀，且不会改动仓库', () => {
  const sim = new Simulator(), before = sim.snapshot();
  assert.equal(suggestions(sim, 'git sta')[0].value, 'git status ');
  assert.equal(suggestions(sim, 'sw')[0].value, 'switch ');
  assert.equal(suggestions(sim, 'gi')[0].value, 'git ');
  assert.deepEqual(suggestions(sim, 'git stash drop '), []);
  assert.deepEqual(suggestions(sim, ''), []);
  assert.ok(complete('', 0, context(sim), true).length);
  assert.deepEqual(sim.snapshot(), before);
});

test('只补全支持的选项，不重复 log 选项或 reset 模式', () => {
  const sim = new Simulator('reset');
  assert.deepEqual(suggestions(sim, 'git log --oneline --').map(x => x.label), ['--graph', '--all']);
  assert.equal(suggestions(sim, 'git diff --ca')[0].value, 'git diff --cached ');
  assert.ok(!suggestions(sim, 'git reset --soft --').length);
  assert.deepEqual(suggestions(sim, 'git fetch --'), []);
  assert.match(suggestions(sim, 'git reset --ha')[0].description, /覆盖/);
  assert.match(usage('git reset '), /--soft/);
});

test('文件名来自实时状态，支持空格、未闭合引号、多个文件和删除路径', () => {
  const sim = new Simulator();
  sim.editFile('中文 notes.txt', 'new\n'); sim.deleteFile('hello.txt');
  let item = suggestions(sim, 'git add "中文 n')[0];
  assert.equal(item.value, 'git add "中文 notes.txt" ');
  assert.deepEqual(parse(item.value).paths, ['中文 notes.txt']);
  assert.ok(suggestions(sim, 'git add h').some(x => x.label === 'hello.txt'));
  assert.ok(!suggestions(sim, 'git add hello.txt ').some(x => x.label === 'hello.txt'));
  item = suggestions(sim, 'git add REA hello.txt', 11)[0];
  assert.equal(item.value, 'git add README.md hello.txt');
  assert.deepEqual(parse(item.value).paths, ['README.md', 'hello.txt']);
  assert.deepEqual(suggestions(sim, 'git add . && git sta'), []);
});

test('分支、远程、提交和祖先引用随仓库变化，远程未下载的提交不能作为本地引用', () => {
  const sim = new Simulator('branches');
  run(sim, 'git branch feature-one');
  assert.equal(suggestions(sim, 'git switch feat')[0].label, 'feature-one');
  assert.ok(!suggestions(sim, 'git switch C').length);
  assert.ok(suggestions(sim, 'git checkout C').length);
  assert.ok(suggestions(sim, 'git checkout HEAD~').some(x => x.label === 'HEAD~1'));
  assert.deepEqual(suggestions(sim, 'git branch -d ma'), []);
  assert.deepEqual(suggestions(sim, 'git push origin fea').map(x => x.label), ['feature-one']);
  sim.simulateRemote();
  const remoteId = sim.state.remote.branches.main;
  assert.ok(!suggestions(sim, 'git checkout C').some(x => x.label === remoteId));
  run(sim, 'git fetch');
  assert.ok(suggestions(sim, 'git checkout C').some(x => x.label === remoteId));
  assert.equal(suggestions(sim, 'git merge origin/')[0].label, 'origin/main');
});

test('提交模板把光标放在引号内，不改写正在输入的中文说明', () => {
  const sim = new Simulator();
  const item = suggestions(sim, 'git commit -m ')[0];
  assert.equal(item.value, 'git commit -m ""');
  assert.equal(item.value.slice(item.start - 1, item.end + 1), '""');
  assert.deepEqual(suggestions(sim, 'git commit -m "中文说明'), []);
});

test('推荐随编辑、暂存、再次编辑、提交和远程状态变化', () => {
  const sim = new Simulator();
  assert.ok(!commands(sim).some(x => x.startsWith('git commit')));
  sim.editFile('hello.txt', '修改\n');
  assert.match(commands(sim)[0], /^git add hello.txt$/);
  run(sim, 'git add hello.txt');
  assert.match(commands(sim)[0], /^git commit -m /);
  sim.editFile('hello.txt', '再次修改\n');
  assert.match(commands(sim)[0], /^git add /);
  assert.ok(commands(sim).some(x => x.startsWith('git commit -m')));
  run(sim, 'git add .'); run(sim, 'git commit -m "完成"');
  assert.ok(commands(sim).includes('git push'));
  sim.simulateRemote();
  assert.equal(commands(sim)[0], 'git fetch origin');
  assert.ok(!commands(sim).includes('git push'));
  run(sim, 'git fetch');
  assert.ok(commands(sim).includes('git pull --no-rebase origin main'));
  assert.ok(!commands(sim).includes('git push'));
});

test('合并负责人按当前目标分支推荐先获取并同步上游，再合入已获取的功能分支', () => {
  const sim = new Simulator();
  const origin = sim.state.remote;
  const integrator = new RemoteWorkspace('main', origin.commits[origin.branches.main], origin, 'integrator');
  const snapshot = () => integrator.commandContext(sim);
  const recommendations = () => recommend(snapshot());
  const mergeCommands = () => recommendations().map(item => item.command).filter(command => command.startsWith('git merge '));
  const integrate = command => {
    const result = integrator.execute(sim, command);
    assert.ok(result.ok && !result.conflict, result.output);
    assert.equal(result.actor, 'integrator');
  };

  assert.match(usage('', snapshot()), /合并负责人.*fetch.*push/);
  assert.match(usage('git commit', snapshot()), /合并负责人.*git push/);
  run(sim, 'git switch -c dev');
  run(sim, 'git push -u origin dev');
  run(sim, 'git switch -c release');
  run(sim, 'git push -u origin release');
  integrate('git fetch origin');
  integrate('git switch release');
  run(sim, 'git switch -c feature-a');
  sim.editFile('a.txt', '功能 A\n');
  run(sim, 'git add a.txt');
  run(sim, 'git commit -m "功能 A"');
  run(sim, 'git push -u origin feature-a');
  run(sim, 'git branch 未发布分支');
  run(sim, 'git switch release');
  sim.editFile('readme-release.txt', '发布说明\n');
  run(sim, 'git add readme-release.txt');
  run(sim, 'git commit -m "更新发布说明"');
  run(sim, 'git push');

  assert.equal(recommendations()[0].command, 'git fetch origin');
  assert.deepEqual(mergeCommands(), []);
  integrate('git fetch origin');
  assert.deepEqual(mergeCommands(), ['git merge origin/release']);
  integrate('git merge origin/release');
  const before = snapshot();
  assert.deepEqual(mergeCommands(), ['git merge origin/feature-a']);
  assert.match(recommendations()[0].description, /当前分支 release/);
  assert.ok(!recommendations().some(item => item.command === 'git switch dev'));
  assert.deepEqual(snapshot(), before);
  integrate('git switch --detach');
  assert.deepEqual(mergeCommands(), []);
  integrate('git switch release');
  integrate('git merge origin/feature-a');
  assert.deepEqual(mergeCommands(), []);
  assert.ok(recommendations().some(item => item.command === 'git push'));
});

test('冲突建议遵循先解决、再暂存、后继续，支持中止与分离 HEAD', () => {
  const sim = new Simulator('conflict');
  run(sim, 'git merge bugFix');
  assert.ok(!commands(sim).some(x => /add|--continue/.test(x)));
  assert.ok(commands(sim).includes('git merge --abort'));
  assert.ok(!suggestions(sim, 'git merge --').some(x => x.label === '--continue'));
  sim.editFile('hello.txt', '已解决\n==========\n正文\n');
  assert.equal(commands(sim)[0], 'git add hello.txt');
  run(sim, 'git add hello.txt');
  assert.equal(commands(sim)[0], 'git merge --continue');
  assert.ok(suggestions(sim, 'git merge --').some(x => x.label === '--continue'));
  run(sim, 'git merge --abort'); run(sim, 'git checkout C0');
  assert.doesNotThrow(() => commands(sim));
  assert.ok(!commands(sim).includes('git push'));
});

test('带冲突标记的暂存结果不推荐继续，草稿解决结果可参与推荐且不更改真实状态', () => {
  const sim = new Simulator('conflict'); run(sim, 'git merge bugFix');
  run(sim, 'git add hello.txt');
  assert.ok(!commands(sim).includes('git merge --continue'));
  const before = sim.snapshot(), draftContext = context(sim);
  draftContext.state = { ...sim.state, work: { ...sim.state.work, 'hello.txt': '草稿解决结果\n' } };
  draftContext.files = draftContext.files.map(f => ({ ...f, unstaged: f.path === 'hello.txt' || f.unstaged }));
  assert.equal(recommend(draftContext)[0].command, 'git add hello.txt');
  assert.deepEqual(sim.snapshot(), before);
});

/** 最小 DOM 检查真实控制器的事件分流，防止候选选择误触发执行或拦截输入法。 */
function controller() {
  class Element {
    constructor() { this.attrs = {}; this.children = []; this.events = {}; this.value = ''; this.selectionStart = 0; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
    querySelectorAll() { return this.children.filter(row => row.attrs.role === 'option'); }
    focus() {}
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    scrollIntoView() {}
  }
  const previous = global.document;
  global.document = { createElement: () => new Element() };
  const input = new Element(); input.form = new Element();
  const assist = new Controller(input, () => context(new Simulator()));
  const fill = text => { input.value = text; input.setSelectionRange(text.length, text.length); assist.refresh(); };
  const key = (key, extra = {}) => {
    const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    assist.keydown(event); return event;
  };
  return { input, assist, fill, key, cleanup: () => { global.document = previous; } };
}

test('Tab 与方向键/Enter 只填入命令，Esc 关闭后方向键可用于历史，Shift+Tab 保持可离开', () => {
  const ui = controller();
  try {
    ui.fill('git sta'); assert.ok(ui.key('Tab').defaultPrevented); assert.equal(ui.input.value, 'git status ');
    ui.fill('git sw'); ui.key('ArrowDown'); assert.equal(ui.input.attrs['aria-activedescendant'], 'command-option-0');
    assert.ok(ui.key('Enter').defaultPrevented); assert.equal(ui.input.value, 'git switch ');
    assert.equal(ui.key('Enter').defaultPrevented, false);
    ui.fill('git re'); assert.equal(ui.key('Tab', { shiftKey: true }).defaultPrevented, false);
    ui.key('Escape'); assert.equal(ui.key('ArrowUp').defaultPrevented, false);
    assert.equal(ui.input.attrs['aria-expanded'], 'false');
  } finally { ui.cleanup(); }
});

test('输入法选字不接管 Enter/方向键，鼠标候选通过文本节点显示', () => {
  const ui = controller();
  try {
    ui.fill('git sta');
    assert.equal(ui.key('ArrowDown', { isComposing: true }).defaultPrevented, false);
    assert.equal(ui.key('Enter', { keyCode: 229 }).defaultPrevented, false);
    ui.assist.composing = true; assert.equal(ui.key('Tab').defaultPrevented, false);
    ui.assist.composing = false;
    const row = ui.assist.list.children[0];
    row.events.click[0](); assert.equal(ui.input.value, 'git status ');
    assert.ok(row.children[0].textContent === 'status');
  } finally { ui.cleanup(); }
});
