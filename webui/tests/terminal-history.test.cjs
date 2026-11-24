const { test } = require('node:test');
const assert = require('node:assert/strict');
const { History, View, copyText } = require('../terminal-history.js');

const entry = (overrides = {}) => ({ actor: 'local', branch: 'main', scene: '基础提交', command: 'git status', output: '工作区干净', result: { ok: true }, timestamp: 1800000000000, ...overrides });

test('命令记录按身份隔离，保留命令原文、中文、分支及真实执行结果', () => {
  const history = new History();
  history.record(entry({ command: 'git commit -m "中文 <script>说明</script>"', branch: 'dev', output: '[dev C3] 中文说明' }));
  history.record(entry({ actor: 'remote', branch: null, command: 'git switch absent', result: { ok: false }, output: '分支不存在' }));
  const own = history.format('local', { scene: '基础提交' }), peer = history.format('remote', { scene: '基础提交' });
  assert.equal(own.count, 1); assert.equal(peer.count, 1);
  assert.match(own.text, /我的本地/); assert.match(own.text, /分支：dev/);
  assert.match(own.text, /\$ git commit -m "中文 <script>说明<\/script>"/);
  assert.ok(!own.text.includes('git switch absent'));
  assert.match(peer.text, /协作者本地/); assert.match(peer.text, /分离 HEAD \| 失败/); assert.match(peer.text, /分支不存在/);
  assert.equal(Object.isFrozen(history.list('local')[0]), true);
});

test('完整历史不受窗口 80 条显示上限影响，失败、冲突、暂停和重复命令都保留', () => {
  const history = new History();
  for (let index = 0; index < 85; index++) history.record(entry({ command: 'git status', output: '记录 ' + index }));
  history.record(entry({ result: { ok: true, conflict: true }, command: 'git merge dev', output: '冲突\r\n请解决' }));
  history.record(entry({ result: { ok: true, paused: true }, command: 'git cherry-pick C3', output: '已暂停' }));
  const text = history.format('local', { scene: '基础提交' });
  assert.equal(text.count, 87); assert.match(text.text, /记录 0\n/); assert.match(text.text, /记录 84\n/);
  assert.match(text.text, /待解决冲突/); assert.match(text.text, /冲突\n请解决/); assert.match(text.text, /已暂停/);
  assert.equal(text.text.match(/\$ git status/g).length, 85);
});

test('清理同时移除双方全部记录，空输入不入历史，新页面没有前次记录', () => {
  const history = new History(); history.record(entry()); history.record(entry({ actor: 'remote' }));
  history.record(entry({ command: '  ' })); assert.equal(history.list().length, 2);
  history.clear(); assert.equal(history.format('local', { scene: '基础提交' }), null);
  assert.equal(history.format('remote', { scene: '基础提交' }), null);
  history.record(entry()); assert.equal(history.list()[0].sequence, 1); assert.deepEqual(new History().list(), []);
  assert.throws(() => history.record(entry({ actor: 'unknown' }))); assert.throws(() => history.list('unknown'));
});

/** 使用最小 DOM 验证按钮行为；剪贴板和场景生命周期由浏览器交互另外验收。 */
function fixture(copy) {
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.events = {}; this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.events[name] = handler; }
  }
  const documentBefore = global.document; global.document = { createElement: () => new Element() };
  const parent = new Element(), history = new History(), context = { actor: 'local', scene: '基础提交' };
  let view; try { view = new View(parent, history, () => ({ ...context }), copy); } finally { global.document = documentBefore; }
  return { parent, history, context, view };
}

test('界面只有一个复制按钮，跟随身份只复制当前窗口的全部记录', async () => {
  const copied = [], f = fixture(async text => copied.push(text));
  assert.equal(f.view.button.disabled, true); assert.equal(f.view.root.children.length, 2);
  f.history.record(entry()); f.history.record(entry({ actor: 'remote', command: 'git fetch origin' })); f.view.update();
  assert.equal(f.view.button.textContent, '复制历史（1）'); assert.equal(f.view.button.disabled, false);
  await f.view.button.events.click(); assert.match(copied[0], /我的本地/); assert.ok(!copied[0].includes('git fetch'));
  assert.match(f.view.feedback.textContent, /已复制：我的本地，共 1 条/);
  f.context.actor = 'remote'; f.view.update(); assert.equal(f.view.feedback.textContent, '');
  await f.view.copyHistory(); assert.match(copied[1], /协作者本地/); assert.match(copied[1], /git fetch origin/);
  assert.ok(!copied[1].includes('$ git status'));
  f.history.record(entry({ actor: 'integrator', command: 'git merge origin/dev' }));
  f.context.actor = 'integrator'; f.view.update();
  await f.view.copyHistory();
  assert.match(copied[2], /复制范围：合并负责人/);
  assert.match(copied[2], /\[3\].*合并负责人/);
  assert.match(copied[2], /\$ git merge origin\/dev/);
  assert.doesNotMatch(copied[2], /\$ git (?:fetch|status)/);
  f.history.clear(); f.view.reset(); assert.equal(f.view.button.disabled, true); assert.equal(f.view.feedback.textContent, '');
  await f.view.copyHistory(); assert.equal(copied.length, 3);
});

test('复制失败明确提示，切换身份或重置后不会出现上一轮异步成功提示', async () => {
  const failed = fixture(async () => { throw new Error('拒绝访问'); }); failed.history.record(entry());
  await failed.view.copyHistory(); assert.match(failed.view.feedback.textContent, /复制失败/); assert.ok(!failed.view.feedback.textContent.includes('已复制'));
  for (const change of ['actor', 'reset']) {
    let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; })); f.history.record(entry());
    const pending = f.view.copyHistory();
    if (change === 'actor') { f.context.actor = 'remote'; f.view.update(); }
    else { f.history.clear(); f.view.reset(); }
    finish(); await pending; assert.equal(f.view.feedback.textContent, '');
  }
});

async function clipboardFixture(clipboard, action) {
  const previousDocument = global.document, previousNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');
  const copied = [], fields = [], selected = [];
  const focused = { isConnected: true, selectionStart: 2, selectionEnd: 4, focus() { selected.push('focus'); }, setSelectionRange(start, end) { selected.push([start, end]); } };
  const document = { activeElement: focused, body: { append() {} }, createElement() { const field = { style: {}, select() { copied.push(this.value); }, remove() { this.removed = true; } }; fields.push(field); return field; }, execCommand(command) { assert.equal(command, 'copy'); return true; } };
  global.document = document; Object.defineProperty(global, 'navigator', { configurable: true, value: { clipboard } });
  try { await action({ copied, fields, selected, document }); }
  finally { global.document = previousDocument; if (previousNavigator) Object.defineProperty(global, 'navigator', previousNavigator); else delete global.navigator; }
}

test('正常环境直接写入剪贴板，文本不创建 HTML 或触发下载', async () => {
  const values = []; await clipboardFixture({ writeText: async text => values.push(text) }, async ({ fields }) => {
    await copyText('<script>中文命令</script>\ngit status'); assert.equal(fields.length, 0);
  });
  assert.deepEqual(values, ['<script>中文命令</script>\ngit status']);
});

test('无剪贴板 API 或权限被拒时使用兼容复制，并恢复输入焦点和选区', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('拒绝'); } }]) {
    await clipboardFixture(clipboard, async ({ copied, fields, selected }) => {
      await copyText('git status\n中文结果'); assert.deepEqual(copied, ['git status\n中文结果']);
      assert.equal(fields[0].removed, true); assert.deepEqual(selected, ['focus', [2, 4]]);
    });
  }
});

test('兼容复制返回失败时不能伪报成功，临时元素仍清理且焦点恢复', async () => {
  await clipboardFixture(undefined, async ({ fields, selected, document }) => {
    document.execCommand = () => false;
    await assert.rejects(copyText('git status'), /未允许复制/);
    assert.equal(fields[0].removed, true); assert.deepEqual(selected, ['focus', [2, 4]]);
  });
});
