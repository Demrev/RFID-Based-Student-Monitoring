'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

function databaseOptions(env = process.env) {
  // DB_* keeps local installations compatible; MYSQL* supports Railway references.
  const options = {
    host: env.DB_HOST || env.MYSQLHOST || '127.0.0.1',
    port: Number(env.DB_PORT || env.MYSQLPORT || 3306),
    user: env.DB_USER || env.MYSQLUSER,
    password: env.DB_PASSWORD ?? env.MYSQLPASSWORD ?? '',
    database: env.DB_NAME || env.MYSQLDATABASE,
    connectionLimit: Number(env.DB_POOL_SIZE || 5),
    waitForConnections: true,
    connectTimeout: 10000,
    dateStrings: true,
    timezone: 'Z',
    decimalNumbers: true
  };
  if (!options.user || !options.database) throw new Error('Set DB_USER and DB_NAME (or MYSQLUSER and MYSQLDATABASE).');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid database port');
  if (!Number.isInteger(options.connectionLimit) || options.connectionLimit < 1 || options.connectionLimit > 50) throw new Error('DB_POOL_SIZE must be between 1 and 50');
  if (env.DB_SSL === 'true') options.ssl = {rejectUnauthorized: true, ...(env.DB_SSL_CA ? {ca: env.DB_SSL_CA.replace(/\\n/g, '\n')} : {})};
  return options;
}

async function initializeDatabase(pool) {
  const schema = await fs.readFile(path.join(__dirname, 'database', 'schema.sql'), 'utf8');
  // Only our checked-in DDL is executed, one statement at a time. No drops or seed data.
  for (const statement of schema.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
}

module.exports = {databaseOptions, initializeDatabase, createPool: env => mysql.createPool(databaseOptions(env))};
