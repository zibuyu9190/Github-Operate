const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);

test('本地静态服务可重复启动，空闲连接不阻塞静态文件，停止后释放端口', async t => {
  const project = fs.realpathSync(path.resolve(__dirname, '../..'));
  const scratch = path.join(project, 'target', 'webui-validation');
  for (const directory of [path.dirname(scratch), scratch]) {
    fs.mkdirSync(directory, { recursive: true });
    assert.equal(fs.realpathSync(directory), directory, '验证目录不能指向项目之外');
  }
  const root = fs.mkdtempSync(path.join(scratch, 'service-'));
  const script = path.join(root, 'scripts', 'GitPlayground.ps1');
  fs.mkdirSync(path.dirname(script));
  fs.copyFileSync(path.join(project, 'scripts', 'GitPlayground.ps1'), script);
  const webRoot = path.join(root, 'webui');
  fs.mkdirSync(webRoot);
  for (const file of fs.readdirSync(path.join(project, 'webui'), { withFileTypes: true })) {
    if (file.isFile()) fs.copyFileSync(path.join(project, 'webui', file.name), path.join(webRoot, file.name));
  }

  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const { port } = reserve.address();
  await new Promise((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const base = 'http://127.0.0.1:' + port;
  const get = (url, options) => fetch(base + url, { signal: AbortSignal.timeout(4000), ...options });
  const action = name => run('pwsh', ['-NoLogo', '-NoProfile', '-File', script, '-Action', name, '-Port', String(port), '-NoBrowser'], {
    cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch }
  });
  let running = false;
  let idle;
  t.after(async () => {
    idle?.destroy();
    if (running) await action('Stop');
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), scratch);
    assert.ok(path.basename(resolved).startsWith('service-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  running = true;
  await action('Start');
  const first = await (await get('/__health')).json();
  assert.equal(first.app, 'git-playground');
  assert.equal(first.port, port);
  await action('Start');
  const reused = await (await get('/__health')).json();
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.instance, first.instance);
  const status = await action('Status');
  assert.match(status.stdout, new RegExp('\\b' + first.pid + '\\b'));

  idle = net.createConnection({ host: '127.0.0.1', port });
  await once(idle, 'connect');
  const css = await Promise.race([
    get('/styles.css', { signal: AbortSignal.timeout(1200) }),
    once(idle, 'close').then(() => { throw new Error('静态请求等到空闲连接超时才返回'); })
  ]);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.ok((await css.text()).length > 0);
  assert.equal(idle.destroyed, false);
  idle.destroy();

  const page = await (await get('/')).text();
  const assets = [...page.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.includes('app.js'));
  for (const response of await Promise.all(assets.map(asset => get('/' + asset, { method: 'HEAD' })))) {
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get('content-length')) > 0);
    assert.equal(await response.text(), '');
  }
  assert.equal((await get('/unlisted.txt')).status, 404);
  await action('Stop');
  running = false;
  await assert.rejects(get('/__health'));
});
