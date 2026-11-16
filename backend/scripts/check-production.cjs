'use strict';
// Uses local DB credentials, but creates and removes only a uniquely named test DB.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
require('dotenv').config({path: path.join(__dirname, '..', '.env')});
const mysql = require('mysql2/promise');
const {databaseOptions} = require('../database');
const name = `rfid_deploy_test_${crypto.randomBytes(8).toString('hex')}`;
const options = databaseOptions();
delete options.database;
const admin = mysql.createPool(options);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let created = false;
let cookie;
let base;
const credentials = {username: 'deployment-test', password: crypto.randomBytes(24).toString('hex')};
const sessionSecret = crypto.randomBytes(32).toString('hex');
const deviceKey = crypto.randomBytes(24).toString('hex');

async function start() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), windowsHide: true,
    env: {...process.env, NODE_ENV: 'production', PORT: String(port), DB_NAME: name, DB_AUTO_INIT: 'true',
      ADMIN_USERNAME: credentials.username, ADMIN_PASSWORD: credentials.password,
      SESSION_SECRET: sessionSecret, DEVICE_API_KEY: deviceKey, TRUST_PROXY_HOPS: '1'}
  });
  let startupFailed = false;
  child.stderr.on('data', () => { startupFailed = true; });
  child.stdout.resume();
  for (let i = 0; i < 100; i++) {
    try {
      const health = await fetch(base + '/api/health');
      if (health.ok) return;
    } catch { /* Wait for the listening socket. */ }
    if (child.exitCode !== null) throw new Error(`Backend exited before becoming healthy${startupFailed ? '; check production configuration' : ''}`);
    await delay(100);
  }
  throw new Error('Production-style backend did not become healthy');
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exiting = once(child, 'exit');
  child.kill();
  await exiting;
  child = null;
}

function request(route, method = 'GET', body, authenticated = true) {
  return fetch(base + route, {
    method, redirect: 'manual',
    headers: {'X-Forwarded-Proto': 'https', ...(authenticated && cookie ? {Cookie: cookie} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {})},
    ...(body !== undefined ? {body: JSON.stringify(body)} : {})
  });
}

(async () => {
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created = true;
  await start();
  assert.equal((await request('/')).status, 302, 'Anonymous visitors must sign in');
  assert.equal((await request('/login')).status, 200);
  assert.equal((await request('/api/admin/students')).status, 401);
  assert.equal((await request('/api/device/students')).status, 401, 'Student display cache requires a device key');
  const login = await request('/api/auth/login', 'POST', credentials, false);
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert(setCookie && /; Secure/i.test(setCookie) && /; HttpOnly/i.test(setCookie), 'Secure cookie works behind HTTPS proxy');
  cookie = setCookie.split(';')[0];
  assert.equal((await request('/')).status, 200);
  const registered = await request('/api/admin/students', 'POST', {student_no: 'DEPLOY-001', full_name: 'Deployment Test', section: 'Test', uid: 'AABBCCDD'});
  assert.equal(registered.status, 201);
  const scan = await fetch(base + '/api/device/scans', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Device-Key': deviceKey}, body: JSON.stringify({uid: 'AABBCCDD', deviceId: 'TEST-DEVICE'})});
  assert.equal(scan.status, 200);
  assert.equal((await scan.json()).event, 'ENTRY');
  await stop();
  await start();
  assert.equal((await request('/api/auth/me')).status, 200);
  assert.equal((await (await request('/api/auth/me')).json()).authenticated, true, 'Login survives process restart');
  const students = await (await request('/api/admin/students')).json();
  assert.equal(students.rows.length, 1, 'Schema initialization preserves existing data');
  const deviceDirectory = async suffix => fetch(base + '/api/device/students' + suffix, {headers: {'X-Device-Key': deviceKey}});
  const directory = await deviceDirectory('');
  assert.equal(directory.status, 200);
  assert.equal(directory.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await directory.json(), {rows: [{uid: 'AABBCCDD', name: 'Deployment Test', section: 'Test'}], nextCursor: null});
  assert.equal((await deviceDirectory('?after=not-a-number')).status, 400);
  assert.equal((await request('/api/admin/students/' + students.rows[0].id + '/active', 'PATCH', {active: false})).status, 200);
  const inactiveScan = await fetch(base + '/api/device/scans', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Device-Key': deviceKey}, body: JSON.stringify({uid: 'AABBCCDD', deviceId: 'TEST-DEVICE'})});
  assert.equal((await inactiveScan.json()).outcome, 'inactive', 'A previously cached card still requires current server authorization');
  assert.equal((await request('/api/admin/students/' + students.rows[0].id + '/active', 'PATCH', {active: true})).status, 200);
  const extra = Array.from({length: 65}, (_, index) => [`CACHE-${index}`, `Cache Student ${index}`, `Course ${index}`, (index + 1).toString(16).padStart(8, '0').toUpperCase(), '2026-11-17 00:00:00']);
  await admin.query(`INSERT INTO \`${name}\`.students (student_no, full_name, section, uid, created_at) VALUES ?`, [extra]);
  const firstPage = await (await deviceDirectory('')).json();
  assert.equal(firstPage.rows.length, 64);
  assert(firstPage.nextCursor);
  const secondPage = await (await deviceDirectory('?after=' + firstPage.nextCursor)).json();
  assert.equal(secondPage.rows.length, 2);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(new Set([...firstPage.rows, ...secondPage.rows].map(row => row.uid)).size, 66, 'Directory pages do not duplicate or skip students');
  const [[scanCount]] = await admin.query(`SELECT COUNT(*) AS total FROM \`${name}\`.attendance`);
  assert.equal(scanCount.total, 1, 'Directory sync never records attendance');
  assert.equal((await request('/api/auth/logout', 'POST', {})).status, 200);
  assert.equal((await (await request('/api/auth/me')).json()).authenticated, false, 'Logout deletes persisted session');
  console.log('PASS: production startup, HTTPS cookies, student registration, device scan, session persistence, logout, and authenticated paginated device directory without attendance side effects.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await stop();
  if (created && /^rfid_deploy_test_[a-f0-9]{16}$/.test(name)) await admin.query(`DROP DATABASE \`${name}\``);
  await admin.end();
});
