'use strict';
const $ = id => document.getElementById(id);
let attendance = [], students = [], unknown = [];
let activeEventFilter = 'ALL';
let activeStudentFilter = 'ALL';
let activeChartFilter = 'ALL';
let toastTimeout;

const screenInfo = {
  overview: {title: 'Overview', description: 'A clear view of your students, attendance, and daily activity.'},
  attendance: {title: 'Attendance', description: 'Browse and export student check-ins and check-outs.'},
  students: {title: 'Students', description: 'Register students and manage their RFID card access.'},
  unknown: {title: 'Unknown cards', description: 'Review unregistered card scans and assign them to students.'}
};

const phtDate = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
$('date').value = phtDate();

function updateDateDisplay() {
  const val = $('date').value;
  $('workspace-date').textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric'
  }).format(new Date(`${val || phtDate()}T12:00:00+08:00`));
  const display = $('active-date-display');
  if (!display) return;
  if (!val || val === phtDate()) {
    display.textContent = `Today (${val || phtDate()})`;
  } else {
    display.textContent = val;
  }
}
updateDateDisplay();

function notify(message, failure = false) {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', failure);
  element.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove('visible'), 3500);
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function showScreen(name, updateHistory = false) {
  const screen = screenInfo[name] ? name : 'overview';
  document.querySelectorAll('[data-screen-page]').forEach(page => {
    const active = page.dataset.screenPage === screen;
    page.hidden = !active;
    page.classList.toggle('is-active', active);
    if (active) {
      page.classList.remove('screen-enter');
      requestAnimationFrame(() => page.classList.add('screen-enter'));
    } else {
      page.classList.remove('screen-enter');
    }
  });
  document.querySelectorAll('[data-screen]').forEach(link => {
    const active = link.dataset.screen === screen;
    if (link.classList.contains('nav-link')) {
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  });
  $('page-title').textContent = screenInfo[screen].title;
  $('page-description').textContent = screenInfo[screen].description;
  $('page-breadcrumb').textContent = screenInfo[screen].title.toUpperCase();
  document.title = `${screenInfo[screen].title} · RFID Based Attendance Monitoring`;
  if (updateHistory) $('page-title').focus({preventScroll: true});
  if (updateHistory && location.hash !== `#${screen}`) {
    history.pushState({screen}, '', `#${screen}`);
  }
}

async function request(path, options) {
  const res = await fetch(path, {credentials: 'same-origin', ...options});
  if (res.status === 401) { location.assign('/login'); throw new Error('Please sign in'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function formatPht(datetime) {
  if (!datetime) return '—';
  const date = new Date(String(datetime).replace(' ', 'T').replace(/\.\d+$/, '') + 'Z');
  return Number.isNaN(+date) ? '—' : new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hour12: true
  }).format(date);
}

function td(text, className) {
  const cell = document.createElement('td');
  cell.textContent = text == null ? '' : String(text);
  if (className) cell.className = className;
  return cell;
}

function createPersonCell(fullName, subtitle) {
  const cell = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'person-cell';
  const avatar = document.createElement('span');
  avatar.className = 'avatar-badge';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initialsOf(fullName);
  const meta = document.createElement('div');
  meta.className = 'person-meta strong-cell';
  meta.textContent = fullName || '—';
  if (subtitle) {
    const sub = document.createElement('small');
    sub.textContent = subtitle;
    meta.append(sub);
  }
  wrap.append(avatar, meta);
  cell.append(wrap);
  return cell;
}

function createUidCell(uid) {
  const cell = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'uid-chip';
  btn.title = 'Click to copy UID';
  btn.textContent = uid || '—';
  btn.addEventListener('click', async () => {
    if (!uid || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(uid);
      notify(`Copied UID ${uid}`);
    } catch {
      /* Ignore clipboard errors */
    }
  });
  cell.append(btn);
  return cell;
}

function emptyRow(bodyId, count, message) {
  const tr = document.createElement('tr');
  const cell = td(message, 'empty');
  cell.colSpan = count;
  tr.append(cell);
  $(bodyId).replaceChildren(tr);
}

function addBadge(text, color) {
  const span = document.createElement('span');
  span.textContent = text;
  span.className = 'chip ' + color;
  return span;
}

function setNavBadge(id, count) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(count);
  el.hidden = !(count > 0);
}

function renderOverviewRecent() {
  const body = $('overview-recent-body');
  if (!body) return;
  const recent = attendance.slice(0, 6);
  if (!recent.length) {
    return emptyRow('overview-recent-body', 4, 'No scans recorded for this date yet');
  }
  const rows = recent.map(x => {
    const tr = document.createElement('tr');
    tr.append(td(formatPht(x.scanned_at)));
    tr.append(createPersonCell(x.full_name, `${x.student_no}${x.section ? ' · ' + x.section : ''}`));
    const event = document.createElement('td');
    event.append(addBadge(x.event_type, x.event_type === 'ENTRY' ? 'green' : 'blue'));
    tr.append(event, td(x.device_id));
    return tr;
  });
  body.replaceChildren(...rows);
}

function renderAttendance() {
  const query = $('attendance-search').value.toLowerCase().trim();
  const items = attendance.filter(x => {
    if (activeEventFilter !== 'ALL' && x.event_type !== activeEventFilter) return false;
    return [x.full_name, x.student_no, x.uid, x.section, x.device_id].some(s => String(s || '').toLowerCase().includes(query));
  });
  const countPill = $('attendance-count-pill');
  if (countPill) countPill.textContent = `${items.length} ${items.length === 1 ? 'scan' : 'scans'}`;
  setNavBadge('nav-badge-attendance', attendance.length);
  renderOverviewRecent();
  renderActivityChart();

  if (!items.length) return emptyRow('attendance-body', 5, 'No attendance records match your filter');
  const rows = items.map(x => {
    const tr = document.createElement('tr');
    tr.append(td(formatPht(x.scanned_at)));
    tr.append(createPersonCell(x.full_name, `${x.student_no}${x.section ? ' · ' + x.section : ''}`));
    tr.append(createUidCell(x.uid));
    const event = document.createElement('td');
    event.append(addBadge(x.event_type, x.event_type === 'ENTRY' ? 'green' : 'blue'));
    tr.append(event, td(x.device_id));
    return tr;
  });
  $('attendance-body').replaceChildren(...rows);
}

function renderStudents() {
  const query = $('student-search').value.toLowerCase().trim();
  const items = students.filter(x => {
    if (activeStudentFilter === 'ACTIVE' && !x.active) return false;
    if (activeStudentFilter === 'INACTIVE' && x.active) return false;
    return [x.full_name, x.student_no, x.uid, x.section].some(s => String(s || '').toLowerCase().includes(query));
  });
  const countPill = $('student-count-pill');
  if (countPill) countPill.textContent = `${items.length} shown`;
  setNavBadge('nav-badge-students', students.length);

  if (!items.length) return emptyRow('student-body', 4, 'No students match your search');
  const rows = items.map(x => {
    const tr = document.createElement('tr');
    tr.append(createPersonCell(x.full_name, `${x.student_no}${x.section ? ' · ' + x.section : ''}`));
    tr.append(createUidCell(x.uid));
    const state = document.createElement('td');
    state.append(addBadge(x.active ? 'Active' : 'Inactive', x.active ? 'green' : 'gray'));
    const action = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'student-actions';

    const edit = document.createElement('button');
    edit.className = 'small-button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      $('edit-student-id').value = x.id;
      $('edit-student-number').value = x.student_no;
      $('edit-student-name').value = x.full_name;
      $('edit-student-section').value = x.section || '';
      $('edit-student-uid').value = x.uid;
      $('student-edit-dialog').showModal();
    });

    const button = document.createElement('button');
    button.className = 'small-button';
    button.textContent = x.active ? 'Disable' : 'Enable';
    button.addEventListener('click', () => openStudentAction(x.active ? 'disable' : 'enable', x));

    const remove = document.createElement('button');
    remove.className = 'small-button danger-button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => openStudentAction('delete', x));

    actions.append(edit, button, remove);
    action.append(actions);
    tr.append(state, action);
    return tr;
  });
  $('student-body').replaceChildren(...rows);
}

function renderUnknownHelper() {
  const helper = $('recent-uid-helper');
  if (!helper) return;
  if (!unknown.length) {
    helper.hidden = true;
    helper.replaceChildren();
    return;
  }
  helper.hidden = false;
  const label = document.createElement('span');
  label.textContent = 'Recent unknown scan:';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'uid-helper-btn';
  btn.textContent = `Use ${unknown[0].uid}`;
  btn.addEventListener('click', () => {
    $('student-uid').value = unknown[0].uid;
    $('student-uid').focus();
  });
  helper.replaceChildren(label, btn);
}

function renderUnknown() {
  $('followup-unknown').textContent = unknown.length;
  const countPill = $('unknown-count-pill');
  if (countPill) countPill.textContent = `${unknown.length} ${unknown.length === 1 ? 'card' : 'cards'}`;
  setNavBadge('nav-badge-unknown', unknown.length);

  const shortcutPill = $('shortcut-unknown-pill');
  if (shortcutPill) {
    shortcutPill.textContent = `${unknown.length} pending`;
    shortcutPill.classList.toggle('has-items', unknown.length > 0);
  }
  renderUnknownHelper();

  if (!unknown.length) return emptyRow('unknown-body', 4, 'No unknown card scans waiting for review');
  $('unknown-body').replaceChildren(...unknown.map(x => {
    const tr = document.createElement('tr');
    tr.append(
      createUidCell(x.uid),
      td(formatPht(x.last_seen_at)),
      td(`${x.scan_count} ${Number(x.scan_count) === 1 ? 'scan' : 'scans'}`)
    );
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.textContent = 'Register card →';
    button.className = 'small-button primary';
    button.addEventListener('click', () => {
      $('student-uid').value = x.uid;
      showScreen('students', true);
      $('student-number').focus();
    });
    action.append(button);
    tr.append(action);
    return tr;
  }));
}

async function loadOverview() {
  const date = $('date').value;
  updateDateDisplay();
  const [stats, log] = await Promise.all([
    request('/api/admin/summary?date=' + encodeURIComponent(date)),
    request('/api/admin/attendance?date=' + encodeURIComponent(date))
  ]);
  $('total-students').textContent = stats.students;
  $('active-students').textContent = `${stats.activeStudents} active cards`;
  $('total-entries').textContent = stats.entries;
  $('total-exits').textContent = stats.exits;
  $('total-unique').textContent = stats.uniqueStudents;
  $('followup-active').textContent = stats.activeStudents;
  $('followup-inactive').textContent = Math.max(0, stats.students - stats.activeStudents);
  $('followup-scanned').textContent = stats.uniqueStudents;
  const rateCaption = $('overview-rate-caption');
  if (rateCaption) {
    const rate = stats.activeStudents > 0 ? Math.min(100, Math.round((stats.uniqueStudents / stats.activeStudents) * 100)) : 0;
    rateCaption.textContent = stats.activeStudents > 0
      ? `${rate}% of active students scanned`
      : 'Unique students on selected date';
  }
  attendance = log.rows;
  renderAttendance();
  $('export').href = '/api/admin/export?date=' + encodeURIComponent(date);
}

async function loadStudents() {
  students = (await request('/api/admin/students')).rows;
  renderStudents();
}

async function loadUnknown() {
  unknown = (await request('/api/admin/unknown')).rows;
  renderUnknown();
}

async function refreshAll(showToast = false) {
  try {
    await Promise.all([loadOverview(), loadStudents(), loadUnknown()]);
    $('live-state').textContent = 'Server connected';
    $('live-state').classList.add('online');
    $('sidebar-connection').textContent = 'Server connected';
    document.body.classList.add('server-online');
    if (showToast) notify('Dashboard refreshed');
  } catch (err) {
    $('live-state').textContent = 'Connection problem';
    $('live-state').classList.remove('online');
    $('sidebar-connection').textContent = 'Connection problem';
    document.body.classList.remove('server-online');
    if ($('chart-total').textContent === '—') $('chart-empty').textContent = 'Unable to load activity. Use refresh to try again.';
    if (showToast) notify(err.message, true);
  }
}

$('attendance-search').addEventListener('input', renderAttendance);
$('student-search').addEventListener('input', renderStudents);

function renderActivityChart() {
  const svg = $('activity-chart');
  const hours = Array(24).fill(0);
  const hourFormatter = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23'});
  attendance.forEach(scan => {
    if (activeChartFilter !== 'ALL' && scan.event_type !== activeChartFilter) return;
    const time = new Date(String(scan.scanned_at).replace(' ', 'T').replace(/\.\d+$/, '') + 'Z');
    if (!Number.isNaN(+time)) hours[Number(hourFormatter.format(time))]++;
  });
  const total = hours.reduce((sum, count) => sum + count, 0);
  $('chart-total').textContent = total.toLocaleString();
  $('chart-empty').hidden = total > 0;
  $('chart-empty').textContent = 'No scans recorded for this date and filter.';
  const max = Math.max(4, Math.ceil(Math.max(...hours) / 4) * 4);
  const ns = 'http://www.w3.org/2000/svg';
  const element = (tag, attributes = {}, content) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    if (content !== undefined) node.textContent = content;
    return node;
  };
  svg.replaceChildren(
    element('title', {id: 'chart-title'}, 'Hourly attendance activity'),
    element('desc', {id: 'chart-description'}, `${total} ${activeChartFilter === 'ALL' ? 'scans' : activeChartFilter.toLowerCase() + ' events'} on ${$('date').value}, Philippine time. ` + hours.map((count, hour) => `${String(hour).padStart(2, '0')}:00: ${count}`).join('; '))
  );
  const defs = element('defs');
  const gradient = element('linearGradient', {id: 'activity-fill', x1: '0', y1: '0', x2: '0', y2: '1'});
  gradient.append(element('stop', {offset: '0%', 'stop-color': '#bcf526', 'stop-opacity': '.24'}), element('stop', {offset: '100%', 'stop-color': '#bcf526', 'stop-opacity': '.015'}));
  defs.append(gradient);
  svg.append(defs);
  for (let step = 0; step <= 4; step++) {
    const y = 20 + step * 47;
    svg.append(element('line', {x1: 38, y1: y, x2: 784, y2: y, stroke: '#303429', 'stroke-width': 1}));
    svg.append(element('text', {x: 25, y: y + 4, fill: '#969d88', 'font-size': 11, 'text-anchor': 'end'}, String(max - max * step / 4)));
  }
  [0, 4, 8, 12, 16, 20, 23].forEach(hour => {
    svg.append(element('text', {x: 38 + hour / 23 * 746, y: 236, fill: '#969d88', 'font-size': 11, 'text-anchor': hour === 0 ? 'start' : hour === 23 ? 'end' : 'middle'}, `${String(hour).padStart(2, '0')}:00`));
  });
  const points = hours.map((count, hour) => [38 + hour / 23 * 746, 208 - count / max * 188]);
  const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  svg.append(element('path', {d: `${path} L784,208 L38,208 Z`, fill: 'url(#activity-fill)'}));
  svg.append(element('path', {d: path, fill: 'none', stroke: '#bcf526', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'}));
  points.forEach(([x, y], hour) => {
    const point = element('circle', {cx: x, cy: y, r: 5, fill: 'transparent', stroke: 'transparent'});
    point.append(element('title', {}, `${String(hour).padStart(2, '0')}:00 · ${hours[hour]} scans`));
    svg.append(point);
  });
}

document.querySelectorAll('[data-chart-filter]').forEach(button => {
  button.addEventListener('click', () => {
    activeChartFilter = button.dataset.chartFilter;
    document.querySelectorAll('[data-chart-filter]').forEach(item => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    renderActivityChart();
  });
});

document.querySelectorAll('[data-event-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    activeEventFilter = btn.dataset.eventFilter;
    document.querySelectorAll('[data-event-filter]').forEach(b => b.classList.toggle('active', b === btn));
    renderAttendance();
  });
});

document.querySelectorAll('[data-student-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    activeStudentFilter = btn.dataset.studentFilter;
    document.querySelectorAll('[data-student-filter]').forEach(b => b.classList.toggle('active', b === btn));
    renderStudents();
  });
});

$('date').addEventListener('change', () => loadOverview().catch(err => notify(err.message, true)));
$('refresh').addEventListener('click', () => refreshAll(true));
if ($('top-refresh')) $('top-refresh').addEventListener('click', () => refreshAll(true));
$('today').addEventListener('click', () => {
  $('date').value = phtDate();
  loadOverview().catch(err => notify(err.message, true));
});

$('student-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/admin/students', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        student_no: $('student-number').value,
        full_name: $('student-name').value,
        section: $('student-section').value,
        uid: $('student-uid').value
      })
    });
    notify('Student registered successfully');
    form.reset();
    await Promise.all([loadStudents(), loadUnknown(), loadOverview()]);
  } catch (err) {
    notify(err.message, true);
  } finally {
    button.disabled = false;
  }
});

let studentAction = null;
let studentActionBusy = false;
const studentActionCopy = {
  disable: {title: 'Disable this card?', description: 'This student’s RFID card will no longer record attendance.', warning: 'Their profile and attendance history will be kept. You can enable the card again at any time.', confirm: 'Disable card', pending: 'Disabling…', success: 'Student card disabled'},
  enable: {title: 'Enable this card?', description: 'This student will be able to record attendance with their RFID card again.', warning: 'Their existing profile and attendance history will stay the same.', confirm: 'Enable card', pending: 'Enabling…', success: 'Student card enabled'},
  delete: {title: 'Delete this student?', description: 'Permanently remove this student, their registered card, and all of their attendance records.', warning: 'This action cannot be undone. To temporarily stop card access, disable the card instead.', confirm: 'Delete student', pending: 'Deleting…', success: 'Student deleted'}
};

function openStudentAction(kind, student) {
  if (studentActionBusy || $('student-action-dialog').open) return;
  studentAction = {kind, student};
  const copy = studentActionCopy[kind];
  $('student-action-dialog').dataset.action = kind;
  $('student-action-title').textContent = copy.title;
  $('student-action-description').textContent = copy.description;
  $('student-action-warning').textContent = copy.warning;
  $('action-student-name').textContent = student.full_name;
  $('action-student-details').textContent = [student.student_no, student.section].filter(Boolean).join(' · ');
  $('action-student-avatar').textContent = initialsOf(student.full_name);
  $('confirm-student-action').textContent = copy.confirm;
  $('student-action-error').hidden = true;
  $('student-action-status').textContent = '';
  $('student-action-dialog').showModal();
  $('cancel-student-action').focus();
}

function closeStudentAction() {
  if (!studentActionBusy) $('student-action-dialog').close();
}
$('cancel-student-action').addEventListener('click', closeStudentAction);
$('close-student-action').addEventListener('click', closeStudentAction);
$('student-action-dialog').addEventListener('cancel', event => {
  if (studentActionBusy) event.preventDefault();
});
$('student-action-dialog').addEventListener('keydown', event => {
  if (studentActionBusy && event.key === 'Escape') event.preventDefault();
});
$('student-action-dialog').addEventListener('close', () => {
  if (!$('student-action-dialog').open) studentAction = null;
});
$('student-action-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!studentAction || studentActionBusy) return;
  const {kind, student} = studentAction;
  const copy = studentActionCopy[kind];
  const buttons = $('student-action-form').querySelectorAll('button');
  studentActionBusy = true;
  $('student-action-dialog').setAttribute('closedby', 'none');
  buttons.forEach(button => { button.disabled = true; });
  $('student-action-form').setAttribute('aria-busy', 'true');
  $('confirm-student-action').textContent = copy.pending;
  $('student-action-status').textContent = copy.pending;
  $('student-action-error').hidden = true;
  try {
    await request(`/api/admin/students/${encodeURIComponent(student.id)}${kind === 'delete' ? '' : '/active'}`, {
      method: kind === 'delete' ? 'DELETE' : 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(kind === 'delete' ? {} : {active: kind === 'enable'})
    });
  } catch (err) {
    $('student-action-error').textContent = err.message;
    $('student-action-error').hidden = false;
    $('student-action-status').textContent = '';
    return;
  } finally {
    studentActionBusy = false;
    $('student-action-dialog').setAttribute('closedby', 'closerequest');
    buttons.forEach(button => { button.disabled = false; });
    $('student-action-form').removeAttribute('aria-busy');
    $('confirm-student-action').textContent = copy.confirm;
  }
  $('student-action-dialog').close();
  notify(copy.success);
  try {
    await Promise.all([loadStudents(), loadOverview(), loadUnknown()]);
  } catch {
    notify(`${copy.success}. Refresh the dashboard to update the records.`, true);
  }
});

$('cancel-student-edit').addEventListener('click', () => $('student-edit-dialog').close());
$('student-edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('save-student-edit');
  button.disabled = true;
  try {
    await request(`/api/admin/students/${encodeURIComponent($('edit-student-id').value)}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        student_no: $('edit-student-number').value,
        full_name: $('edit-student-name').value,
        section: $('edit-student-section').value,
        uid: $('edit-student-uid').value
      })
    });
    $('student-edit-dialog').close();
    notify('Student updated successfully');
    await Promise.all([loadStudents(), loadOverview()]);
  } catch (err) {
    notify(err.message, true);
  } finally {
    button.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  try {
    await request('/api/auth/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    location.assign('/login');
  } catch (err) {
    notify(err.message, true);
  }
});

document.querySelectorAll('[data-screen]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  showScreen(link.dataset.screen, true);
}));
window.addEventListener('popstate', () => showScreen(location.hash.slice(1)));
window.addEventListener('hashchange', () => showScreen(location.hash.slice(1)));

showScreen(location.hash.slice(1));
refreshAll();
setInterval(() => { if (!document.hidden) refreshAll(); }, 6000);
