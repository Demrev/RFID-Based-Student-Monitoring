'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {databaseOptions, initializeDatabase} = require('../database');

test('accepts Railway database variables and preserves local DB overrides', () => {
  const railway = {MYSQLHOST: 'mysql.railway.internal', MYSQLPORT: '3306', MYSQLUSER: 'root', MYSQLPASSWORD: 'example-password', MYSQLDATABASE: 'railway'};
  assert.equal(databaseOptions(railway).host, 'mysql.railway.internal');
  assert.equal(databaseOptions(railway).database, 'railway');
  const local = databaseOptions({...railway, DB_HOST: '127.0.0.1', DB_PASSWORD: '', DB_NAME: 'local'});
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.password, '');
  assert.equal(local.database, 'local');
});

test('validates pool limits and keeps certificate verification enabled', () => {
  const env = {DB_USER: 'test', DB_NAME: 'test'};
  assert.throws(() => databaseOptions({...env, DB_PORT: 'invalid'}));
  assert.throws(() => databaseOptions({...env, DB_POOL_SIZE: '0'}));
  assert.deepEqual(databaseOptions({...env, DB_SSL: 'true', DB_SSL_CA: 'line1\\nline2'}).ssl, {rejectUnauthorized: true, ca: 'line1\nline2'});
});

test('deployment schema creates tables in the selected database without dropping data', async () => {
  const statements = [];
  await initializeDatabase({query: async sql => statements.push(sql)});
  assert.equal(statements.length, 3);
  assert(statements.every(sql => /^CREATE TABLE IF NOT EXISTS /.test(sql)));
  assert(statements.every(sql => !/\b(DROP|TRUNCATE|USE|CREATE DATABASE)\b/i.test(sql)));
});
