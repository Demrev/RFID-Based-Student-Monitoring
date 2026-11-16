'use strict';
const toggleBtn = document.getElementById('toggle-password');
const passwordInput = document.getElementById('password');
if (toggleBtn && passwordInput) {
  toggleBtn.addEventListener('click', () => {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    toggleBtn.textContent = isHidden ? 'Hide' : 'Show';
    toggleBtn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  });
}

const loginForm = document.getElementById('login-form');
loginForm.addEventListener('input', () => {
  passwordInput.removeAttribute('aria-invalid');
  document.getElementById('login-error').textContent = '';
  document.querySelector('.login-card').classList.remove('login-rejected');
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('login-error');
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const label = document.getElementById('login-button-label');
  const spinner = button.querySelector('.login-spinner');
  const status = document.getElementById('login-status');
  const card = document.querySelector('.login-card');
  let signedIn = false;
  card.classList.remove('login-rejected', 'login-approved');
  passwordInput.removeAttribute('aria-invalid');
  error.textContent = '';
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  spinner.hidden = false;
  label.textContent = 'Signing in…';
  status.textContent = 'Checking your credentials…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    });
    // Rate-limit responses may be plain text rather than JSON.
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      passwordInput.setAttribute('aria-invalid', 'true');
      // Restart the animation on each unsuccessful attempt.
      void card.offsetWidth;
      card.classList.add('login-rejected');
    }
    if (response.status === 429) throw new Error('Too many sign-in attempts. Please try again later.');
    if (!response.ok) throw new Error(result.error || 'Sign in failed');
    label.textContent = 'Opening dashboard…';
    status.textContent = 'Signed in successfully. Opening your dashboard…';
    card.classList.add('login-approved');
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await new Promise(resolve => setTimeout(resolve, 450));
    }
    location.assign('/');
    signedIn = true;
  } catch (err) {
    error.textContent = err.message;
    status.textContent = '';
    if (passwordInput.getAttribute('aria-invalid') === 'true') {
      passwordInput.focus();
      passwordInput.select();
    }
  } finally {
    if (!signedIn) {
      button.disabled = false;
      spinner.hidden = true;
      label.textContent = 'Sign in';
      card.classList.remove('login-approved');
      form.removeAttribute('aria-busy');
    }
  }
});
