const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const project = fs.realpathSync(path.resolve(__dirname, '../..'));
const scratch = path.join(project, 'target', 'webui-validation');
const url = pathToFileURL(path.join(project, 'webui', 'index.html')).href;
let browser;

before(async () => {
  // Playwright 创建和清理的浏览器配置与截图临时目录也留在项目验证目录中。
  for (const directory of [path.dirname(scratch), scratch]) {
    fs.mkdirSync(directory, { recursive: true });
    assert.equal(fs.realpathSync(directory), directory, '验证目录不能指向项目之外');
  }
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = scratch;
  const executablePath = process.env.GIT_PLAYGROUND_CHROMIUM;
  assert.ok(executablePath, '请将 GIT_PLAYGROUND_CHROMIUM 指向本机 Chrome 或 Edge');
  const { chromium } = require('playwright');
  browser = await chromium.launch({ executablePath });
});
after(async () => browser?.close());

async function open(t, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.goto(url);
  return page;
}

async function command(page, text) {
  await page.locator('#command').fill(text);
  await page.locator('#command').press('Enter');
  assert.match(await page.locator('#terminal .terminal-command-status').last().textContent(), /成功|待解决冲突/);
}

test('打开三个弹窗时，问号快捷键不会叠加命令手册', async t => {
  const page = await open(t);
  for (const id of ['repository-browser', 'graph-viewer', 'help-dialog']) {
    const trigger = id === 'help-dialog' ? '#help-button' : 'button[aria-controls="' + id + '"]';
    await page.locator(trigger).click();
    const dialog = page.locator('#' + id);
    await dialog.locator('button').first().focus();
    await page.keyboard.press('?');
    assert.deepEqual(await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(node => node.id)), [id]);
    await page.keyboard.press('Escape');
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
  }
  await page.locator('#help-button').focus();
  await page.keyboard.press('?');
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
});

test('协作者草稿与提交说明分别验证，推送后区分跟踪引用和共享分支', async t => {
  const page = await open(t);
  const editor = page.locator('#file-editor');
  await editor.fill('本地草稿\n');
  await page.locator('#terminal-remote').click();
  assert.doesNotMatch(await editor.inputValue(), /本地草稿/);
  await editor.fill('协作者草稿\n');
  await page.locator('#terminal-local').click();
  assert.match(await editor.inputValue(), /本地草稿/);
  await page.locator('#terminal-remote').click();
  assert.match(await editor.inputValue(), /协作者草稿/);
  await page.locator('#remote-stage-file').click();
  const message = page.locator('#remote-message');
  for (const value of ['', '   ']) {
    await message.fill(value);
    await page.locator('#remote-submit').click();
    assert.match(await page.locator('#file-message').textContent(), /请填写提交说明/);
    assert.equal(await message.evaluate(input => input === document.activeElement), true);
  }
  await message.fill('提交协作者草稿');
  await page.locator('#remote-submit').click();
  await page.locator('#remote-push').click();
  assert.match(await page.locator('#remote-editor-base').textContent(), /共享远程分支 main/);
  assert.match(await page.locator('#repository-status .repository-status-upstream').textContent(), /origin\/main/);
});

test('合并负责人获取两人的分支、解决冲突并统一推送，三方状态各自保留', async t => {
  const page = await open(t, { width: 390, height: 844 });
  const editor = page.locator('#file-editor');
  const input = page.locator('#command');
  const history = page.locator('#terminal-history-copy');
  const devSync = page.locator('#remote-sync tr').filter({ has: page.getByRole('rowheader', { name: 'dev', exact: true }) });
  const tips = () => devSync.locator('td').allTextContents();
  await command(page, 'git switch -c dev');
  await command(page, 'git push -u origin dev');
  await command(page, 'git switch -c feature-order');
  await editor.fill('订单改动\n');
  await command(page, 'git add hello.txt');
  await command(page, 'git commit -m "订单开发"');
  await command(page, 'git push -u origin feature-order');
  await editor.fill('我的草稿\n');
  await input.fill('我的待执行命令');

  await page.locator('#terminal-remote').click();
  await command(page, 'git fetch origin');
  await command(page, 'git switch dev');
  await command(page, 'git switch -c feature-cart');
  await editor.fill('购物车改动\n');
  await command(page, 'git add hello.txt');
  await command(page, 'git commit -m "购物车开发"');
  await command(page, 'git push -u origin feature-cart');
  await editor.fill('协作者草稿\n');
  await input.fill('协作者待执行命令');

  await page.getByRole('group', { name: '选择命令执行身份' }).getByRole('button', { name: '合并负责人' }).click();
  await page.locator('#remote-sync summary').click();
  assert.equal(await page.locator('#editor-integrator').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#repository-status').textContent(), /合并负责人本地仓库/);
  assert.deepEqual(await tips(), ['C2', '尚未获取未同步']);
  assert.equal(await history.isDisabled(), true);
  assert.equal(await input.inputValue(), '');
  await command(page, 'git fetch origin');
  await command(page, 'git switch dev');
  await command(page, 'git merge origin/dev');
  const suggestedCommands = () => page.locator('#quick-commands code').allTextContents();
  assert.deepEqual((await suggestedCommands()).slice(0, 2), ['git merge origin/feature-order', 'git merge origin/feature-cart']);
  await command(page, 'git merge origin/feature-order');
  assert.equal((await suggestedCommands())[0], 'git merge origin/feature-cart');
  await command(page, 'git merge origin/feature-cart');
  assert.equal(await page.locator('.file-marker-warning').count(), 1);
  await editor.fill('保留订单和购物车改动\n');
  await page.locator('#remote-stage-file').click();
  await command(page, 'git merge --continue');
  assert.deepEqual(await tips(), ['C2', 'C2']);
  await command(page, 'git push');
  assert.deepEqual(await tips(), ['C5', 'C5']);
  assert.match(await page.locator('#terminal .terminal-command').last().textContent(), /合并负责人 · dev/);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { async writeText(text) { window.copiedHistory = text; } }
    });
  });
  await history.click();
  await page.waitForFunction(() => Boolean(window.copiedHistory));
  const copied = await page.evaluate(() => window.copiedHistory);
  assert.match(copied, /复制范围：合并负责人/);
  assert.match(copied, /命令数量：8/);
  assert.doesNotMatch(copied, /订单开发|购物车开发/);

  await page.locator('button[aria-controls="repository-browser"]').click();
  assert.match(await page.locator('#repository-browser .repo-badge').textContent(), /合并负责人视角/);
  await page.keyboard.press('Escape');
  await page.locator('#terminal-local').click();
  assert.equal(await input.inputValue(), '我的待执行命令');
  assert.equal(await editor.inputValue(), '我的草稿\n');
  assert.match(await page.locator('#head-file').textContent(), /订单改动/);
  assert.deepEqual(await tips(), ['C5', 'C2未同步']);
  await page.locator('#terminal-remote').click();
  assert.equal(await input.inputValue(), '协作者待执行命令');
  assert.equal(await editor.inputValue(), '协作者草稿\n');
  assert.match(await page.locator('#head-file').textContent(), /购物车改动/);
  assert.deepEqual(await tips(), ['C5', 'C2未同步']);
});

test('辅助身份下拉框隔离未获取分支，跟踪进度在 fetch 前后明确区分', async t => {
  const page = await open(t);
  const editor = page.locator('#file-editor');
  const input = page.locator('#command');
  const upstream = page.locator('#repository-status .repository-status-upstream');
  const shared = page.locator('#remote-editor-base');
  async function expectNoBranch(branch) {
    for (const id of ['#terminal-branch', '#editor-remote-branch']) {
      assert.equal(await page.locator(id).locator(`option[value="${branch}"]`).count(), 0);
    }
  }
  await command(page, 'git branch private-local');
  await page.locator('#terminal-remote').click();
  await expectNoBranch('private-local');
  await command(page, 'git branch private-collaborator');
  await page.locator('#terminal-integrator').click();
  await expectNoBranch('private-local');
  await expectNoBranch('private-collaborator');
  await input.fill('git commit');
  assert.match(await page.locator('#command-assist-hint').textContent(), /合并负责人.*git push/);
  assert.match(await page.locator('#remote-message').getAttribute('placeholder'), /合并冲突/);

  await page.locator('#terminal-local').click();
  await command(page, 'git push -u origin private-local');
  await editor.fill('共享 main 的新进度\n');
  await command(page, 'git add hello.txt');
  await command(page, 'git commit -m "更新 main"');
  await command(page, 'git push');
  await page.locator('#terminal-integrator').click();
  await expectNoBranch('private-local');
  assert.match(await upstream.textContent(), /落后 0 个提交/);
  assert.match(await shared.textContent(), /共享远程有更新，请先 fetch/);
  assert.doesNotMatch(await shared.textContent(), /落后|少 1 个提交/);

  await command(page, 'git fetch origin');
  assert.equal(await page.locator('#terminal-branch option[value="private-local"]').count(), 1);
  assert.equal(await page.locator('#editor-remote-branch option[value="private-local"]').count(), 1);
  await expectNoBranch('private-collaborator');
  assert.match(await upstream.textContent(), /落后 1 个提交/);
  assert.match(await shared.textContent(), /先把上游的改动合入当前分支/);
  await command(page, 'git merge origin/main');
  assert.match(await upstream.textContent(), /落后 0 个提交/);
  assert.match(await shared.textContent(), /与共享远程同步/);
});

test('共享远程初始为空时，首次推送为辅助身份建仓，后续更新各自获取', async t => {
  const page = await open(t);
  await page.addInitScript(() => {
    // 在生产初始化前提供空远程测试数据，沿用实际界面和命令入口。
    Object.defineProperty(window, 'GitSimulator', {
      configurable: true,
      set(api) {
        Object.defineProperty(window, 'GitSimulator', { configurable: true, writable: true, value: api });
        const loadScene = api.Simulator.prototype.loadScene;
        api.Simulator.prototype.loadScene = function (scene) {
          loadScene.call(this, scene);
          this.state.remote = { commits: {}, branches: {} };
          this.state.tracking = {};
          this.state.upstreams = {};
        };
      }
    });
  });
  await page.reload();
  const collaborators = page.locator('#terminal-remote, #terminal-integrator');
  for (const button of await collaborators.all()) assert.equal(await button.isDisabled(), true);
  assert.equal(await page.locator('#editor-integrator').isDisabled(), true);

  await command(page, 'git push -u origin main');
  for (const button of await collaborators.all()) assert.equal(await button.isEnabled(), true);
  await command(page, 'git switch -c dev');
  await command(page, 'git push -u origin dev');
  const devOption = page.locator('#terminal-branch option[value="dev"]');
  await page.locator('#editor-integrator').click();
  assert.match(await page.locator('#head-label').textContent(), /合并负责人 · main/);
  assert.equal(await devOption.count(), 0);
  await command(page, 'git fetch origin');
  assert.equal(await devOption.count(), 1);
  await page.locator('#terminal-remote').click();
  assert.equal(await devOption.count(), 0);

  await page.locator('#restart').click();
  for (const button of await collaborators.all()) assert.equal(await button.isDisabled(), true);
  await page.locator('#undo-restart').click();
  assert.equal(await page.locator('#terminal-remote').getAttribute('aria-pressed'), 'true');
  assert.equal(await devOption.count(), 0);
  await page.locator('#terminal-integrator').click();
  assert.equal(await devOption.count(), 1);
});

test('场景重置清空合并负责人状态并可撤销恢复', async t => {
  const page = await open(t);
  const integrator = page.locator('#terminal-integrator');
  const input = page.locator('#command');
  const editor = page.locator('#file-editor');
  await integrator.click();
  await command(page, 'git switch -c integration');
  await editor.fill('合并负责人草稿\n');
  await input.fill('git status');
  await page.locator('#restart').click();
  await integrator.click();
  assert.doesNotMatch(await page.locator('#head-label').textContent(), /integration/);
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('#terminal-history-copy').isDisabled(), true);
  await page.locator('#undo-restart').click();
  assert.equal(await integrator.getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#head-label').textContent(), /integration/);
  assert.equal(await editor.inputValue(), '合并负责人草稿\n');
  assert.equal(await input.inputValue(), 'git status');
  assert.match(await page.locator('#terminal-history-copy').textContent(), /（1）/);
});

test('撤销重置恢复协作者冲突，选择删除后仍可暂存并继续', async t => {
  const page = await open(t);
  await page.locator('#terminal-remote').click();
  await command(page, 'git branch other');
  await command(page, 'git rm hello.txt');
  await command(page, 'git commit -m "删除"');
  await command(page, 'git switch other');
  await page.locator('#file-select').selectOption('hello.txt');
  const editor = page.locator('#file-editor');
  await editor.fill('另一分支修改\n');
  await command(page, 'git add hello.txt');
  await command(page, 'git commit -m "修改"');
  await command(page, 'git switch main');
  await command(page, 'git merge other');
  await page.locator('#restart').click();
  assert.equal(await page.locator('.file-marker-warning').count(), 0);
  await page.locator('#undo-restart').click();
  const warning = page.locator('.file-marker-warning');
  assert.equal(await warning.count(), 1);
  await editor.fill('标题\n==========\n正常正文\n');
  assert.equal(await warning.count(), 0);
  await editor.fill('>>>>>>> other\n');
  assert.equal(await warning.count(), 1);
  await page.locator('#use-ours').click();
  assert.equal(await page.locator('#file-select').inputValue(), 'hello.txt');
  assert.equal(await warning.count(), 0);
  await page.locator('#remote-stage-file').click();
  await command(page, 'git merge --continue');
  assert.equal(await page.locator('#file-select option[value="hello.txt"]').count(), 0);
});

test('撤销重置恢复双方仓库、未保存草稿和命令历史', async t => {
  const page = await open(t);
  const undo = page.getByRole('button', { name: '撤销重置' });
  const editor = page.locator('#file-editor');
  const input = page.locator('#command');
  const historyCopy = page.locator('#terminal-history-copy');
  assert.equal(await undo.isDisabled(), true);

  await editor.fill('本地提交\n');
  await command(page, 'git add hello.txt');
  await command(page, 'git commit -m "重置前的提交"');
  await editor.fill('本地暂存\n');
  await command(page, 'git add hello.txt');
  await editor.fill('本地草稿\n');
  await input.fill('local draft');
  await page.locator('#terminal-remote').click();
  await editor.fill('协作者提交\n');
  await command(page, 'git add hello.txt');
  await command(page, 'git commit -m "协作者提交"');
  await command(page, 'git push');
  const remoteSync = await page.locator('#remote-sync table').textContent();
  await editor.fill('协作者草稿\n');
  await page.locator('#remote-message').fill('待填写完整的提交说明');
  await input.fill('remote draft');

  await page.locator('#replay').click();
  await page.locator('#restart').click();
  assert.equal(await page.locator('#replay').getAttribute('aria-pressed'), 'false');
  assert.equal(await undo.isEnabled(), true);
  assert.equal(await historyCopy.isDisabled(), true);
  assert.equal(await input.inputValue(), '');
  await command(page, 'git switch -c reset-work');
  await undo.click();

  assert.equal(await undo.isDisabled(), true);
  assert.equal(await page.locator('#terminal-remote').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#head-file').textContent(), /协作者提交/);
  assert.equal(await page.locator('#remote-sync table').textContent(), remoteSync);
  assert.equal(await editor.inputValue(), '协作者草稿\n');
  assert.equal(await page.locator('#remote-message').inputValue(), '待填写完整的提交说明');
  assert.equal(await input.inputValue(), 'remote draft');
  assert.equal(await historyCopy.textContent(), '复制历史（3）');
  assert.doesNotMatch(await page.locator('#terminal').textContent(), /reset-work/);
  await input.press('ArrowUp');
  assert.equal(await input.inputValue(), 'git push');
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), 'remote draft');

  await page.locator('#terminal-local').click();
  assert.equal(await input.inputValue(), 'local draft');
  assert.equal(await historyCopy.textContent(), '复制历史（3）');
  assert.match(await page.locator('#head-file').textContent(), /本地提交/);
  assert.match(await page.locator('#index-file').textContent(), /本地暂存/);
  assert.equal(await editor.inputValue(), '本地草稿\n');
  await command(page, 'git branch');
  assert.doesNotMatch(await page.locator('#terminal .terminal-output').last().textContent(), /reset-work/);
});

test('撤销只保留最近一次重置，恢复验收后用完，切换场景或刷新后失效', async t => {
  const page = await open(t, { width: 320, height: 800 });
  const restart = page.locator('#restart');
  const undo = page.locator('#undo-restart');
  const scenario = key => page.locator(`#scenes [data-scene="${key}"]`);
  const route = page.locator('#lesson-route');
  const badge = page.locator('.lesson-badge');
  const input = page.locator('#command');
  const undoBox = await undo.boundingBox();
  assert.ok(undoBox && undoBox.x >= 0 && undoBox.x + undoBox.width <= 320);
  await scenario('reset').click();
  await page.locator('#lesson-guide summary').click();
  await route.selectOption('mixed');
  await command(page, 'git reset --mixed HEAD~1');
  assert.match(await badge.textContent(), /已完成/);
  await input.fill('older draft');
  await restart.click();
  assert.match(await badge.textContent(), /待完成/);

  await route.selectOption('hard');
  await command(page, 'git reset --hard HEAD~1');
  await input.fill('latest draft');
  await scenario('reset').click();
  assert.match(await badge.textContent(), /待完成/);
  await route.selectOption('soft');
  await undo.click();
  assert.equal(await route.inputValue(), 'hard');
  assert.match(await badge.textContent(), /已完成/);
  assert.equal(await input.inputValue(), 'latest draft');
  assert.equal(await undo.isDisabled(), true);

  await restart.click();
  await scenario('basic').click();
  assert.equal(await undo.isDisabled(), true);
  await restart.click();
  assert.equal(await undo.isEnabled(), true);
  await page.reload();
  assert.equal(await undo.isDisabled(), true);
});

async function completeGraph(page) {
  const bounds = await page.locator('#graph').evaluate(svg => {
    const stage = svg.parentElement;
    const frame = stage.getBoundingClientRect();
    const graph = svg.getBoundingClientRect();
    const caption = stage.querySelector('.canvas-caption');
    const inside = (box, area) => box.left >= area.left - 1 && box.right <= area.right + 1 &&
      box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
    const shapes = [...svg.querySelectorAll('.commit-node, .branch-tag, .commit-edge')];
    return {
      nodes: svg.querySelectorAll('.commit-node').length,
      scale: svg.getScreenCTM().a,
      fits: graph.width > 0 && graph.height > 0 && inside(graph, frame) &&
        shapes.every(shape => inside(shape.getBoundingClientRect(), graph)) &&
        (!caption.getClientRects().length || caption.getBoundingClientRect().bottom <= graph.top + 1) &&
        stage.scrollWidth <= stage.clientWidth + 1 && stage.scrollHeight <= stage.clientHeight + 1
    };
  });
  assert.ok(bounds.nodes > 0 && bounds.scale > 0 && bounds.fits, JSON.stringify(bounds));
  return bounds;
}

test('分叉场景初次进入和展开详情时，所有节点、标签与连线都完整显示', async t => {
  const page = await open(t, { width: 1366, height: 768 });
  for (const scene of ['remote', 'rescue']) {
    await page.locator(`#scenes [data-scene="${scene}"]`).click();
    await completeGraph(page);
    await page.locator('#graph .commit-node').first().press('Enter');
    await page.locator('#commit-summary').click();
    await completeGraph(page);
    await page.locator('#lesson-guide summary').click();
    await completeGraph(page);
  }
});

test('长历史在新增提交、重播、缩放、放大查看与窄屏下始终完整显示', async t => {
  const page = await open(t);
  assert.equal(await page.locator('#scenes button').count(), 9);
  assert.equal(await page.locator('#scene-number').textContent(), '场景 01 / 09');
  await page.evaluate(() => {
    const input = document.getElementById('command');
    const form = document.getElementById('command-form');
    const editor = document.getElementById('file-editor');
    for (let i = 0; i < 15; i++) {
      editor.value = '长历史测试 ' + i + '\n';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      for (const text of ['git add hello.txt', 'git commit -m "测试 ' + i + '"']) {
        input.value = text;
        form.requestSubmit();
      }
    }
  });
  const main = await completeGraph(page);
  assert.equal(main.nodes, 18);
  await page.locator('#replay').click();
  assert.equal((await completeGraph(page)).nodes, 17);
  await page.locator('#replay[aria-pressed="false"]').waitFor();
  assert.equal((await completeGraph(page)).nodes, 18);

  await page.locator('#zoom-out').click();
  assert.ok((await completeGraph(page)).scale < main.scale);
  await page.locator('#zoom-default').click();
  assert.ok(Math.abs((await completeGraph(page)).scale - main.scale) < .001);
  await page.locator('#zoom-in').click();
  const mainFitted = await completeGraph(page);
  assert.equal(await page.locator('#zoom-in').isDisabled(), true);

  await page.locator('#graph-expand').click();
  const expanded = await completeGraph(page);
  assert.ok(expanded.scale > mainFitted.scale);
  await page.getByRole('button', { name: '适应大图画布' }).click();
  assert.ok((await completeGraph(page)).scale >= expanded.scale);
  assert.equal(await page.getByRole('button', { name: '放大大图' }).isDisabled(), true);
  await page.locator('#graph .commit-node').first().press('Enter');
  await page.locator('.graph-viewer-details > summary').click();
  await completeGraph(page);
  await page.getByRole('button', { name: '恢复大图默认缩放' }).click();
  await completeGraph(page);
  await page.getByRole('button', { name: '关闭放大图' }).click();
  await page.locator('.visual-panel #graph').waitFor();
  assert.ok(Math.abs((await completeGraph(page)).scale - mainFitted.scale) < .001);

  await page.setViewportSize({ width: 412, height: 860 });
  await completeGraph(page);
  await page.locator('#zoom-default').click();
  await completeGraph(page);
  await page.locator('#scenes [data-scene="remote"]').click();
  await completeGraph(page);
});

test('矮窗口（1024x480）允许页面纵向滚动并可正常编辑保存文件', async t => {
  const page = await open(t, { width: 1024, height: 480 });
  const scrollable = await page.evaluate(() => ({
    overflowY: getComputedStyle(document.body).overflowY,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight
  }));
  assert.notEqual(scrollable.overflowY, 'hidden');
  assert.ok(scrollable.scrollHeight > scrollable.innerHeight);

  const editor = page.locator('#file-editor');
  const save = page.locator('#save-file');
  await editor.scrollIntoViewIfNeeded();
  const editorBox = await editor.boundingBox();
  assert.ok(editorBox && editorBox.height >= 60);
  await editor.fill('矮窗口编辑保存测试\n');
  await save.scrollIntoViewIfNeeded();
  await save.click();
  assert.equal(await page.locator('#editor-status').textContent(), '编辑后保存到工作区');
  assert.match(await page.locator('#file-message').textContent(), /已保存到工作区/);
});
