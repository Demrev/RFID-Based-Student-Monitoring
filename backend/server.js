'use strict';

require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const {rateLimit} = require('express-rate-limit');
const mysql = require('mysql2/promise');
const {normalizeUid, philippineToday, dayRangeUtc, nextAttendanceEvent, csvCell} = require('./lib');

function required(key, minLength = 1) {
  const value = process.env[key] || '';
  if (value.length < minLength || value.startsWith('CHANGE_THIS') || value.startsWith('YOUR_')) {
    throw new Error(`Set ${key} in backend/.env before starting.`);
  }
  return value;
}

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = required('ADMIN_USERNAME');
const ADMIN_PASSWORD = required('ADMIN_PASSWORD', 8);
const DEVICE_API_KEY = required('DEVICE_API_KEY', 16);
const SESSION_SECRET = required('SESSION_SECRET', 32);
const DB_NAME = required('DB_NAME');
const SCAN_COOLDOWN_MS = Number(process.env.SCAN_COOLDOWN_MS || 5000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
if (!Number.isInteger(SCAN_COOLDOWN_MS) || SCAN_COOLDOWN_MS < 500 || SCAN_COOLDOWN_MS > 600000) {
  throw new Error('SCAN_COOLDOWN_MS must be between 500 and 600000.');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: required('DB_USER'),
  password: process.env.DB_PASSWORD || '',
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  timezone: 'Z',
  decimalNumbers: true
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy: {
  directives: {defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"]}
}}));
app.use(express.json({limit: '8kb'}));
app.use(session({
  name: 'rfid_admin_session',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
  // Default memory session store is development-only. See README before deployment.
}));

function constantTimeEquals(input, expected) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({error: 'Sign in required'});
  next();
}

function requireDevice(req, res, next) {
  const token = req.get('X-Device-Key') || '';
  if (!constantTimeEquals(token, DEVICE_API_KEY)) return res.status(401).json({error: 'Invalid device key'});
  next();
}

function ensureSafeMutation(req, res, next) {
  const origin = req.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('Host')) return res.status(403).json({error: 'Invalid request origin'});
    } catch { return res.status(403).json({error: 'Invalid request origin'}); }
  }
  if (!req.is('application/json')) return res.status(415).json({error: 'Send JSON data'});
  next();
}

const loginLimiter = rateLimit({windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false});
const deviceLimiter = rateLimit({windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ok: true, database: 'connected'});
  } catch {
    return res.status(503).json({ok: false, database: 'unavailable'});
  }
});

app.post('/api/auth/login', loginLimiter, ensureSafeMutation, (req, res, next) => {
  const {username, password} = req.body || {};
  if (!constantTimeEquals(username || '', ADMIN_USERNAME) || !constantTimeEquals(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({error: 'Incorrect username or password'});
  }
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.admin = true;
    req.session.save(saveErr => saveErr ? next(saveErr) : res.json({ok: true}));
  });
});
app.get('/api/auth/me', (req, res) => res.json({authenticated: Boolean(req.session?.admin)}));
app.post('/api/auth/logout', requireAdmin, ensureSafeMutation, (req, res, next) => {
  req.session.destroy(err => err ? next(err) : res.json({ok: true}));
});

// Device-facing endpoint: the backend, not the ESP32, decides identity and ENTRY/EXIT.
app.post('/api/device/scans', deviceLimiter, requireDevice, ensureSafeMutation, async (req, res) => {
  const uid = normalizeUid(req.body?.uid);
  const deviceId = req.body?.deviceId || 'ESP32-01';
  if (!uid || typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(deviceId)) {
    return res.status(400).json({error: 'Invalid UID or device ID'});
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock student row so two devices cannot produce overlapping ENTRY/EXIT events.
    const [students] = await conn.execute(
      'SELECT id, full_name, section, active FROM students WHERE uid = ? LIMIT 1 FOR UPDATE', [uid]
    );
    if (!students.length) {
      await conn.execute(`
        INSERT INTO unknown_cards (uid, first_seen_at, last_seen_at, scan_count)
        VALUES (?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 1)
        ON DUPLICATE KEY UPDATE last_seen_at = UTC_TIMESTAMP(3), scan_count = scan_count + 1
      `, [uid]);
      await conn.commit();
      return res.json({ok: true, outcome: 'unknown', registered: false, name: 'Unknown', uid});
    }
    const student = students[0];
    if (!student.active) {
      await conn.commit();
      return res.json({ok: true, outcome: 'inactive', registered: false,
        name: student.full_name, section: student.section || '', uid});
    }
    const [last] = await conn.execute(`
      SELECT event_type, scanned_at,
             TIMESTAMPDIFF(MICROSECOND, scanned_at, UTC_TIMESTAMP(3)) AS elapsed_us
      FROM attendance WHERE student_id = ? ORDER BY id DESC LIMIT 1
    `, [student.id]);
    if (last.length && Number(last[0].elapsed_us) >= 0 && Number(last[0].elapsed_us) < SCAN_COOLDOWN_MS * 1000) {
      await conn.commit();
      return res.json({ok: true, outcome: 'cooldown', registered: true,
        name: student.full_name, section: student.section || '', uid,
        retry_after_ms: Math.max(0, SCAN_COOLDOWN_MS - Math.floor(Number(last[0].elapsed_us) / 1000))});
    }
    // First successful scan of each Philippine calendar day is ENTRY.
    const todayStartUtc = dayRangeUtc(philippineToday())[0];
    const eventType = nextAttendanceEvent(last[0] || null, todayStartUtc);
    await conn.execute(`
      INSERT INTO attendance (student_id, uid, event_type, device_id, scanned_at)
      VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))
    `, [student.id, uid, eventType, deviceId]);
    await conn.commit();
    return res.json({ok: true, outcome: 'recorded', registered: true, name: student.full_name,
      section: student.section || '', uid, event: eventType});
  } catch (error) {
    try { await conn.rollback(); } catch { /* Ignore rollback error. */ }
    throw error;
  } finally {
    conn.release();
  }
});

// Admin dashboard APIs.
const adminApi = express.Router();
adminApi.use(requireAdmin);
function requestedDay(req, res) {
  const day = req.query.date || philippineToday();
  const range = dayRangeUtc(day);
  if (!range) {
    res.status(400).json({error: 'Use a valid date YYYY-MM-DD'});
    return null;
  }
  return {day, range};
}

adminApi.get('/summary', async (req, res) => {
  const selected = requestedDay(req, res);
  if (!selected) return;
  const [[studentCount], [attendanceCount]] = await Promise.all([
    pool.query('SELECT COUNT(*) AS total, SUM(active = 1) AS active FROM students'),
    pool.execute(`SELECT COUNT(*) AS scans,
         COALESCE(SUM(event_type = 'ENTRY'), 0) AS entries,
         COALESCE(SUM(event_type = 'EXIT'), 0) AS exits,
         COUNT(DISTINCT student_id) AS uniqueStudents
       FROM attendance WHERE scanned_at >= ? AND scanned_at < ?`, selected.range)
  ]);
  return res.json({date: selected.day, students: Number(studentCount[0].total),
    activeStudents: Number(studentCount[0].active || 0),
    scans: Number(attendanceCount[0].scans), entries: Number(attendanceCount[0].entries),
    exits: Number(attendanceCount[0].exits), uniqueStudents: Number(attendanceCount[0].uniqueStudents)});
});

const attendanceSelect = `
  SELECT a.id, a.uid, a.event_type, a.device_id, a.scanned_at,
         s.student_no, s.full_name, s.section
  FROM attendance a JOIN students s ON s.id = a.student_id
  WHERE a.scanned_at >= ? AND a.scanned_at < ?
  ORDER BY a.id DESC`;

adminApi.get('/attendance', async (req, res) => {
  const selected = requestedDay(req, res);
  if (!selected) return;
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit || '150', 10) || 150));
  const [rows] = await pool.query(`${attendanceSelect} LIMIT ${limit}`, selected.range);
  return res.json({date: selected.day, rows});
});

adminApi.get('/export', async (req, res) => {
  const selected = requestedDay(req, res);
  if (!selected) return;
  const [rows] = await pool.execute(attendanceSelect, selected.range);
  const headings = ['Date/time (Philippines)', 'Student number', 'Name', 'Section', 'Card UID', 'Event', 'Device'];
  function localTime(utc) {
    const raw = String(utc).replace(' ', 'T').replace(/\.\d+$/, '') + 'Z';
    return new Intl.DateTimeFormat('en-PH', {timeZone: 'Asia/Manila',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).format(new Date(raw));
  }
  const csv = [headings, ...rows.map(r => [localTime(r.scanned_at), r.student_no, r.full_name,
    r.section, r.uid, r.event_type, r.device_id])].map(line => line.map(csvCell).join(',')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="attendance-${selected.day}.csv"`);
  return res.send('\ufeff' + csv);
});

adminApi.get('/students', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT id, student_no, full_name, section, uid, active
    FROM students ORDER BY full_name ASC LIMIT 1000
  `);
  return res.json({rows});
});

function studentInput(body) {
  const {student_no: number, full_name: name, section} = body || {};
  const uid = normalizeUid(body?.uid);
  const studentNo = typeof number === 'string' ? number.trim() : '';
  const fullName = typeof name === 'string' ? name.trim() : '';
  const classSection = typeof section === 'string' ? section.trim() : '';
  if (!uid || !studentNo || studentNo.length > 40 || fullName.length < 2 || fullName.length > 120 || classSection.length > 80) {
    return null;
  }
  return {studentNo, fullName, classSection, uid};
}

adminApi.post('/students', ensureSafeMutation, async (req, res) => {
  const student = studentInput(req.body);
  if (!student) {
    return res.status(400).json({error: 'Provide student number, full name and valid card UID'});
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(`
      INSERT INTO students (student_no, full_name, section, uid, active, created_at)
      VALUES (?, ?, ?, ?, 1, UTC_TIMESTAMP(3))
    `, [student.studentNo, student.fullName, student.classSection || null, student.uid]);
    await conn.execute('DELETE FROM unknown_cards WHERE uid = ?', [student.uid]);
    await conn.commit();
    return res.status(201).json({ok: true, id: result.insertId});
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({error: 'Card UID or student number is already registered'});
    throw err;
  } finally { conn.release(); }
});

adminApi.put('/students/:id', ensureSafeMutation, async (req, res) => {
  const id = Number(req.params.id);
  const student = studentInput(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !student) {
    return res.status(400).json({error: 'Provide a valid student ID, student number, full name and card UID'});
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(`
      UPDATE students SET student_no = ?, full_name = ?, section = ?, uid = ?
      WHERE id = ?
    `, [student.studentNo, student.fullName, student.classSection || null, student.uid, id]);
    if (!result.affectedRows) {
      const [rows] = await conn.execute('SELECT id FROM students WHERE id = ?', [id]);
      if (!rows.length) {
        await conn.rollback();
        return res.status(404).json({error: 'Student not found'});
      }
    }
    await conn.execute('DELETE FROM unknown_cards WHERE uid = ?', [student.uid]);
    await conn.commit();
    return res.json({ok: true});
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({error: 'Card UID or student number is already registered'});
    throw err;
  } finally { conn.release(); }
});

adminApi.delete('/students/:id', ensureSafeMutation, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({error: 'Invalid student ID'});
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [students] = await conn.execute('SELECT id FROM students WHERE id = ? FOR UPDATE', [id]);
    if (!students.length) {
      await conn.rollback();
      return res.status(404).json({error: 'Student not found'});
    }
    await conn.execute('DELETE FROM attendance WHERE student_id = ?', [id]);
    const [result] = await conn.execute('DELETE FROM students WHERE id = ?', [id]);
    await conn.commit();
    if (!result.affectedRows) return res.status(404).json({error: 'Student not found'});
    return res.json({ok: true});
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally { conn.release(); }
});

adminApi.patch('/students/:id/active', ensureSafeMutation, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || typeof req.body?.active !== 'boolean') {
    return res.status(400).json({error: 'Invalid student or active value'});
  }
  const [result] = await pool.execute('UPDATE students SET active = ? WHERE id = ?', [req.body.active, id]);
  if (!result.affectedRows) return res.status(404).json({error: 'Student not found'});
  return res.json({ok: true});
});

adminApi.get('/unknown', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT uid, last_seen_at, scan_count FROM unknown_cards
    ORDER BY last_seen_at DESC LIMIT 30
  `);
  return res.json({rows});
});
app.use('/api/admin', adminApi);

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/login', (req, res) => {
  if (req.session?.admin) return res.redirect('/');
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/', (req, res) => {
  if (!req.session?.admin) return res.redirect('/login');
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((req, res) => res.status(404).json({error: 'Not found'}));
app.use((error, req, res, next) => {
  if (error.code === 'ER_NO_SUCH_TABLE') {
    console.error('Missing database table. Import database/schema.sql.');
  } else {
    console.error('Server error:', error.message);
  }
  if (res.headersSent) return next(error);
  res.status(500).json({error: 'Server/database error. Check Node.js console and MySQL configuration.'});
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RFID dashboard running at http://localhost:${PORT}`);
  console.log('For the ESP32, use your computer LAN IPv4 address, not localhost.');
});
