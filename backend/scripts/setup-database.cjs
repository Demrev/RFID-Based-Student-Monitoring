'use strict';
require('dotenv').config({path: require('node:path').join(__dirname, '..', '.env')});
const {createPool, initializeDatabase} = require('../database');
const pool = createPool();
initializeDatabase(pool)
  .then(() => console.log('Attendance tables are ready. Existing records were kept.'))
  .catch(error => { console.error('Database setup failed:', error.code || 'Check database configuration'); process.exitCode = 1; })
  .finally(() => pool.end());
