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

test('协作者冲突提示识别标记，选择删除后仍可暂存并继续', async t => {
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
