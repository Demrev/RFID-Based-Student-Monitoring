// Browser smoke check with isolated fixtures; no database or credentials required.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = path.resolve(__dirname, '../public');
const students = [{id: 1, full_name: 'Alex Rivera', student_no: '2026-001', uid: 'AABBCCDD', section: 'BSIT 3A', active: 1}];
const scans = [
  {full_name: 'Alex Rivera', student_no: '2026-001', uid: 'AABBCCDD', event_type: 'ENTRY', scanned_at: '2026-11-16 01:00:00', device_id: 'ESP32-01'},
  {full_name: 'Alex Rivera', student_no: '2026-001', uid: 'AABBCCDD', event_type: 'EXIT', scanned_at: '2026-11-16 08:00:00', device_id: 'ESP32-01'}
];
const mutations = [];
let rejectDelete = true;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (/^\/api\/admin\/students\/1(?:\/active)?$/.test(url.pathname) && ['PATCH', 'DELETE'].includes(req.method)) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      mutations.push({method: req.method, body: JSON.parse(body)});
      const failure = req.method === 'DELETE' && rejectDelete;
      if (req.method === 'DELETE') rejectDelete = false;
      if (req.method === 'PATCH') students[0].active = Number(JSON.parse(body).active);
      setTimeout(() => res.writeHead(failure ? 500 : 200, {'Content-Type': 'application/json'}).end(JSON.stringify(failure ? {error: 'Could not delete student. Try again.'} : {ok: true})), 800);
    });
    return;
  }
  if (url.pathname === '/api/auth/login') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const credentials = JSON.parse(body);
      const accepted = credentials.username === 'demo-admin' && credentials.password === 'demo-password';
      setTimeout(() => res.writeHead(accepted ? 200 : 401, {'Content-Type': 'application/json'}).end(JSON.stringify(accepted ? {ok: true} : {error: 'Invalid username or password'})), 150);
    });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const data = url.pathname.endsWith('/summary') ? {students: 1, activeStudents: 1, entries: 1, exits: 1, uniqueStudents: 1}
      : {rows: url.pathname.endsWith('/students') ? students : url.pathname.endsWith('/attendance') ? scans : []};
    res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(data));
    return;
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname === '/login' ? '/login.html' : url.pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const types = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg'};
  res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
let browser, socket;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rfid-dashboard-'));
(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {windowsHide: true, stdio: 'ignore'});
  browser.on('error', error => { console.error(error.message); });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
  assert(fs.existsSync(portFile), 'Chrome must start');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const handler = pending.get(message.id); pending.delete(message.id); message.error ? handler.reject(message.error) : handler.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, {resolve, reject}); socket.send(JSON.stringify({id, method, params})); });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  await call('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/`});
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.getElementById('chart-total')?.textContent === '2'")) break;
    await delay(100);
  }
  assert.equal(await evaluate("document.getElementById('chart-total').textContent"), '2');
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(11, 12, 11)');
  await evaluate("document.getElementById('theme-toggle').click()");
  for (let i = 0; i < 30; i++) {
    if (await evaluate("document.documentElement.dataset.theme === 'light' && document.getAnimations().some(animation => animation.effect?.pseudoElement === '::view-transition-new(root)')")) break;
    await delay(20);
  }
  assert(await evaluate("document.getAnimations().some(animation => animation.effect?.pseudoElement === '::view-transition-new(root)')"), 'Circular reveal animation runs');
  for (let i = 0; i < 100 && await evaluate("document.getElementById('theme-toggle').disabled"); i++) await delay(20);
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(245, 246, 242)');
  assert.equal(await evaluate("document.getElementById('theme-toggle').getAttribute('aria-label')"), 'Switch to dark mode');
  const lightScreenshot = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
  fs.writeFileSync(path.join(os.tmpdir(), 'rfid-dashboard-light.png'), Buffer.from(lightScreenshot.data, 'base64'));
  await call('Page.reload');
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.getElementById('chart-total')?.textContent === '2'")) break;
    await delay(50);
  }
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'light', 'Theme survives reload');
  await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await evaluate("document.getElementById('theme-toggle').click()");
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
  assert.equal(await evaluate("document.getAnimations().filter(animation => animation.effect?.pseudoElement === '::view-transition-new(root)').length"), 0, 'Reduced motion skips reveal');
  await call('Emulation.setEmulatedMedia', {features: []});
  assert.equal(await evaluate("document.getElementById('followup-active').textContent"), '1');
  assert.equal(await evaluate("document.querySelectorAll('#activity-chart circle').length"), 24);
  await evaluate("document.querySelector('[data-chart-filter=ENTRY]').click()");
  assert.equal(await evaluate("document.getElementById('chart-total').textContent"), '1');
  assert.equal(await evaluate("document.querySelector('[data-chart-filter=ENTRY]').getAttribute('aria-pressed')"), 'true');
  await evaluate("document.querySelector('.add-student').click()");
  assert.equal(await evaluate("document.getElementById('screen-students').hidden"), false);
  assert.equal(await evaluate("document.querySelectorAll('#student-body tr').length"), 1);
  await evaluate("document.querySelector('#student-body .student-actions button').click()");
  assert.equal(await evaluate("document.getElementById('student-edit-dialog').open"), true);
  await evaluate("document.getElementById('cancel-student-edit').click(); document.querySelector('#student-body .student-actions button:nth-child(2)').click()");
  assert.equal(await evaluate("document.getElementById('student-action-title').textContent"), 'Disable this card?');
  assert.equal(await evaluate("document.activeElement.id"), 'cancel-student-action');
  assert.equal(await evaluate("document.getElementById('action-student-name').textContent"), 'Alex Rivera');
  await evaluate("document.getElementById('cancel-student-action').click()");
  assert.equal(mutations.length, 0, 'Cancel never sends a mutation');
  await evaluate("document.querySelector('#student-body .student-actions button:nth-child(2)').click(); document.getElementById('student-action-form').requestSubmit()");
  assert(await evaluate("document.getElementById('confirm-student-action').disabled"));
  await call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  assert(await evaluate("document.getElementById('student-action-dialog').open"), 'Escape cannot dismiss an in-flight request');
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.querySelector('#student-body .student-actions button:nth-child(2)')?.textContent === 'Enable'")) break;
    await delay(20);
  }
  assert.deepEqual(mutations[0], {method: 'PATCH', body: {active: false}});
  await evaluate("document.querySelector('#student-body .student-actions button:nth-child(2)').click(); document.getElementById('student-action-form').requestSubmit()");
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.querySelector('#student-body .student-actions button:nth-child(2)')?.textContent === 'Disable'")) break;
    await delay(20);
  }
  assert.deepEqual(mutations[1], {method: 'PATCH', body: {active: true}});
  await evaluate("document.querySelector('#student-body .danger-button').click()");
  assert.equal(await evaluate("document.getElementById('student-action-title').textContent"), 'Delete this student?');
  assert(await evaluate("document.getElementById('student-action-warning').textContent.includes('cannot be undone')"));
  const actionShot = await call('Page.captureScreenshot', {format: 'png'});
  fs.writeFileSync(path.join(os.tmpdir(), 'rfid-delete-dialog.png'), Buffer.from(actionShot.data, 'base64'));
  await call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  assert.equal(await evaluate("document.getElementById('student-action-dialog').open"), false, 'Escape cancels before submission');
  assert.equal(mutations.length, 2);
  await evaluate("document.querySelector('#student-body .danger-button').click(); document.getElementById('student-action-form').requestSubmit()");
  for (let i = 0; i < 100; i++) {
    if (await evaluate("!document.getElementById('student-action-error').hidden")) break;
    await delay(20);
  }
  assert(await evaluate("document.getElementById('student-action-dialog').open"), 'Failed requests keep the dialog open');
  assert.equal(await evaluate("document.getElementById('confirm-student-action').disabled"), false, 'Failed requests can be retried');
  await evaluate("document.getElementById('student-action-form').requestSubmit()");
  for (let i = 0; i < 100 && await evaluate("document.getElementById('student-action-dialog').open"); i++) await delay(20);
  assert.equal(await evaluate("document.getElementById('student-action-dialog').open"), false);
  assert.equal(mutations.filter(item => item.method === 'DELETE').length, 2, 'Delete retries only after explicit confirmation');
  await evaluate("document.querySelector('.nav-link[data-screen=overview]').click()");
  for (const width of [1440, 1024, 768, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width, height: 1100, deviceScaleFactor: 1, mobile: width < 640});
    await delay(100);
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `No page overflow at ${width}px`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: disable/enable/delete confirmations, cancel and Escape behavior, pending controls, request payloads, and error retry.');
  const screenshot = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
  const screenshotPath = path.join(os.tmpdir(), 'rfid-dashboard-mobile.png');
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  await delay(100);
  const desktop = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
  fs.writeFileSync(path.join(os.tmpdir(), 'rfid-dashboard-desktop.png'), Buffer.from(desktop.data, 'base64'));
  await call('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/login`});
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(document.getElementById('login-form') && document.readyState === 'complete')")) break;
    await delay(50);
  }
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
  await evaluate("document.getElementById('theme-toggle').click()");
  for (let i = 0; i < 100 && await evaluate("document.getElementById('theme-toggle').disabled"); i++) await delay(20);
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(245, 246, 242)');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await evaluate("document.getElementById('theme-toggle').click()");
      for (let i = 0; i < 100 && await evaluate("document.getElementById('theme-toggle').disabled"); i++) await delay(20);
    }
    for (const width of [1440, 768, 390, 320]) {
      await call('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: width < 640});
      await delay(50);
      assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `Login has no overflow at ${width}px in ${theme} mode`);
      assert(await evaluate("document.getElementById('username').getBoundingClientRect().width > 150"));
      if (width === 1440 || width === 390) {
        const shot = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
        fs.writeFileSync(path.join(os.tmpdir(), `rfid-login-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  }
  await evaluate("document.getElementById('toggle-password').click()");
  assert.equal(await evaluate("document.getElementById('password').type"), 'text');
  await evaluate("document.getElementById('toggle-password').click(); document.getElementById('username').value = 'demo-admin'; document.getElementById('password').value = 'wrong-password'; document.getElementById('login-form').requestSubmit()");
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.getElementById('login-error').textContent.length > 0")) break;
    await delay(20);
  }
  assert.equal(await evaluate("document.getElementById('password').getAttribute('aria-invalid')"), 'true');
  assert.equal(await evaluate("document.querySelector('.login-submit').disabled"), false);
  await evaluate("document.getElementById('password').value = 'demo-password'; document.getElementById('password').dispatchEvent(new Event('input', {bubbles: true})); document.getElementById('login-form').requestSubmit()");
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(document.getElementById('chart-total')?.textContent === '2')")) break;
    await delay(30);
  }
  assert.equal(await evaluate('location.pathname'), '/', 'Successful login opens dashboard');
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark', 'Login theme carries into dashboard');
  assert.deepEqual(errors, []);
  console.log('PASS: login themes, responsive layouts, password visibility, invalid credentials, successful sign-in redirect, and shared theme preference.');
  console.log('PASS: theme toggle, circular reveal, persistence, reduced motion, chart filters, navigation, student edit dialog, and layouts at 1440/1024/768/390px. No browser errors.');
  console.log(`Screenshots: ${screenshotPath}, ${path.join(os.tmpdir(), 'rfid-dashboard-desktop.png')}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  socket?.close();
  browser?.kill();
  server.close();
});
