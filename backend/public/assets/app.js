'use strict';
const $ = id => document.getElementById(id);
let attendance = [], students = [], unknown = [];
let toastTimeout;
const screenInfo = {
  overview: {title: 'Attendance overview', description: 'A quick summary of today’s attendance activity.'},
  attendance: {title: 'Attendance', description: 'Browse and export student check-ins and check-outs.'},
  students: {title: 'Students', description: 'Register students and manage their RFID card access.'},
  unknown: {title: 'Unknown cards', description: 'Review unregistered card scans and assign them to students.'}
};
const phtDate = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Manila',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x => [x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
$('date').value = phtDate();

function notify(message, failure=false) {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', failure);
  element.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove('visible'), 3500);
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
  document.title = `${screenInfo[screen].title} · RFID Console`;
  if (updateHistory) $('page-title').focus({preventScroll: true});
  if (updateHistory && location.hash !== `#${screen}`) {
    history.pushState({screen}, '', `#${screen}`);
  }
  if (window.matchMedia('(max-width: 640px)').matches) {
    document.querySelector('.app-shell').classList.remove('nav-open');
    if (typeof updateSidebarToggle === 'function') updateSidebarToggle();
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
    timeZone:'Asia/Manila', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit',
    second:'2-digit', hour12:true
  }).format(date);
}
function td(text, className) {
  const cell = document.createElement('td');
  cell.textContent = text == null ? '' : String(text);
  if (className) cell.className = className;
  return cell;
}
function emptyRow(bodyId, count, message) {
  const tr = document.createElement('tr');
  const cell = td(message, 'empty'); cell.colSpan = count; tr.append(cell);
  $(bodyId).replaceChildren(tr);
}
function addBadge(text, color) {
  const span = document.createElement('span');
  span.textContent = text;
  span.className = 'chip ' + color;
  return span;
}
function renderAttendance() {
  const query = $('attendance-search').value.toLowerCase().trim();
  const items = attendance.filter(x => [x.full_name,x.student_no,x.uid,x.section].some(s => String(s||'').toLowerCase().includes(query)));
  if (!items.length) return emptyRow('attendance-body',5,'No attendance records for this date');
  const rows = items.map(x => {
    const tr = document.createElement('tr');
    tr.append(td(formatPht(x.scanned_at)));
    const person = td(x.full_name, 'strong-cell');
    const sub = document.createElement('small'); sub.textContent = `${x.student_no}${x.section ? ' · '+x.section : ''}`; person.append(sub);
    tr.append(person, td(x.uid,'mono'));
    const event = document.createElement('td'); event.append(addBadge(x.event_type, x.event_type==='ENTRY'?'green':'blue')); tr.append(event, td(x.device_id));
    return tr;
  });
  $('attendance-body').replaceChildren(...rows);
}
function renderStudents() {
  const query = $('student-search').value.toLowerCase().trim();
  const items = students.filter(x => [x.full_name,x.student_no,x.uid,x.section].some(s => String(s||'').toLowerCase().includes(query)));
  if (!items.length) return emptyRow('student-body',4,'No students found');
  const rows = items.map(x => {
    const tr = document.createElement('tr');
    const person = td(x.full_name,'strong-cell');
    const sub = document.createElement('small');
    sub.textContent = `${x.student_no}${x.section ? ' · '+x.section : ''}`;
    person.append(sub);
    tr.append(person,td(x.uid,'mono'));
    const state = document.createElement('td'); state.append(addBadge(x.active ? 'Active' : 'Inactive', x.active ? 'green' : 'gray'));
    const action = document.createElement('td');
    const actions = document.createElement('div'); actions.className = 'student-actions';
    const edit = document.createElement('button'); edit.className = 'small-button'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      $('edit-student-id').value = x.id;
      $('edit-student-number').value = x.student_no;
      $('edit-student-name').value = x.full_name;
      $('edit-student-section').value = x.section || '';
      $('edit-student-uid').value = x.uid;
      $('student-edit-dialog').showModal();
    });
    const button = document.createElement('button'); button.className = 'small-button';
    button.textContent = x.active ? 'Disable' : 'Enable';
    button.addEventListener('click', async () => {
      if (!confirm(`${x.active ? 'Disable' : 'Enable'} ${x.full_name}'s card?`)) return;
      button.disabled = true;
      try {
        await request(`/api/admin/students/${x.id}/active`, {method:'PATCH', headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!x.active})});
        notify('Student status updated'); await loadStudents();
      } catch(err){notify(err.message,true); button.disabled=false;}
    });
    const remove = document.createElement('button'); remove.className = 'small-button danger-button'; remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!confirm(`Permanently delete ${x.full_name} and all of their attendance history? This cannot be undone.`)) return;
      remove.disabled = true;
      try {
        await request(`/api/admin/students/${x.id}`, {method:'DELETE', headers:{'Content-Type':'application/json'}, body:'{}'});
        notify('Student deleted');
        await Promise.all([loadStudents(),loadOverview()]);
      } catch(err){notify(err.message,true); remove.disabled=false;}
    });
    actions.append(edit,button,remove); action.append(actions); tr.append(state,action); return tr;
  });
  $('student-body').replaceChildren(...rows);
}
function renderUnknown() {
  if (!unknown.length) return emptyRow('unknown-body',4,'No unknown card scans yet');
  $('unknown-body').replaceChildren(...unknown.map(x => {
    const tr = document.createElement('tr');
    tr.append(td(x.uid,'mono'),td(formatPht(x.last_seen_at)),td(x.scan_count));
    const action = document.createElement('td'); const button=document.createElement('button');
    button.textContent='Register'; button.className='small-button';
    button.addEventListener('click',() => {
      $('student-uid').value=x.uid;
      showScreen('students', true);
      $('student-number').focus();
    });
    action.append(button); tr.append(action); return tr;
  }));
}
async function loadOverview() {
  const date = $('date').value;
  const [stats, log] = await Promise.all([
    request('/api/admin/summary?date='+encodeURIComponent(date)),
    request('/api/admin/attendance?date='+encodeURIComponent(date))
  ]);
  $('total-students').textContent = stats.students;
  $('active-students').textContent = `${stats.activeStudents} active cards`;
  $('total-entries').textContent = stats.entries;
  $('total-exits').textContent = stats.exits;
  $('total-unique').textContent = stats.uniqueStudents;
  attendance = log.rows;
  renderAttendance();
  $('export').href = '/api/admin/export?date='+encodeURIComponent(date);
}
async function loadStudents() {
  students = (await request('/api/admin/students')).rows;
  renderStudents();
}
async function loadUnknown() {
  unknown = (await request('/api/admin/unknown')).rows;
  renderUnknown();
}
async function refreshAll(showToast=false) {
  try {
    await Promise.all([loadOverview(),loadStudents(),loadUnknown()]);
    $('live-state').textContent = 'Server connected'; $('live-state').classList.add('online');
    if (showToast) notify('Dashboard refreshed');
  } catch(err) {
    $('live-state').textContent = 'Connection problem'; $('live-state').classList.remove('online');
    if (showToast) notify(err.message,true);
  }
}
$('attendance-search').addEventListener('input', renderAttendance);
$('student-search').addEventListener('input', renderStudents);
$('date').addEventListener('change',() => loadOverview().catch(err=>notify(err.message,true)));
$('refresh').addEventListener('click',()=>refreshAll(true));
$('today').addEventListener('click',()=>{$('date').value=phtDate(); loadOverview().catch(err=>notify(err.message,true));});
$('student-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button'); button.disabled=true;
  try {
    await request('/api/admin/students',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({student_no:$('student-number').value,full_name:$('student-name').value,
        section:$('student-section').value,uid:$('student-uid').value})});
    notify('Student registered successfully');
    form.reset();
    await Promise.all([loadStudents(),loadUnknown(),loadOverview()]);
  } catch(err){ notify(err.message,true); }
  finally{ button.disabled=false; }
});
$('cancel-student-edit').addEventListener('click', () => $('student-edit-dialog').close());
$('student-edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('save-student-edit'); button.disabled = true;
  try {
    await request(`/api/admin/students/${encodeURIComponent($('edit-student-id').value)}`, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({student_no:$('edit-student-number').value,full_name:$('edit-student-name').value,
        section:$('edit-student-section').value,uid:$('edit-student-uid').value})
    });
    $('student-edit-dialog').close();
    notify('Student updated successfully');
    await loadStudents();
  } catch(err){ notify(err.message,true); }
  finally{ button.disabled=false; }
});
$('logout').addEventListener('click', async () => {
  try { await request('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    location.assign('/login'); } catch(err) {notify(err.message,true);}
});
document.querySelectorAll('[data-screen]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  showScreen(link.dataset.screen, true);
}));
window.addEventListener('popstate', () => showScreen(location.hash.slice(1)));
window.addEventListener('hashchange', () => showScreen(location.hash.slice(1)));
const sidebarToggle = $('sidebar-toggle');
const appShell = document.querySelector('.app-shell');
const mobileSidebar = window.matchMedia('(max-width: 640px)');
function updateSidebarToggle() {
  const isMobile = mobileSidebar.matches;
  const collapsed = !isMobile && appShell.classList.contains('sidebar-collapsed');
  const expanded = isMobile
    ? appShell.classList.contains('nav-open')
    : !collapsed;
  const label = isMobile
    ? (expanded ? 'Close navigation' : 'Open navigation')
    : (expanded ? 'Collapse sidebar' : 'Expand sidebar');
  sidebarToggle.setAttribute('aria-label', label);
  sidebarToggle.setAttribute('title', label);
  sidebarToggle.setAttribute('aria-expanded', String(expanded));
  document.querySelectorAll('.nav-link').forEach(link => {
    if (collapsed) link.title = link.textContent.trim();
    else link.removeAttribute('title');
  });
}
sidebarToggle.addEventListener('click', () => {
  if (mobileSidebar.matches) {
    appShell.classList.toggle('nav-open');
  } else {
    appShell.classList.toggle('sidebar-collapsed');
  }
  updateSidebarToggle();
});
mobileSidebar.addEventListener('change', () => {
  appShell.classList.remove('nav-open', 'sidebar-collapsed');
  updateSidebarToggle();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mobileSidebar.matches && appShell.classList.contains('nav-open')) {
    appShell.classList.remove('nav-open');
    updateSidebarToggle();
    sidebarToggle.focus();
  }
});
updateSidebarToggle();
showScreen(location.hash.slice(1));
refreshAll();
setInterval(() => {if (!document.hidden) refreshAll();}, 6000);
