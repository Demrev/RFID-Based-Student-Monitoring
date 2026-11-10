'use strict';
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById('login-error');
  const button = form.querySelector('button');
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: document.getElementById('username').value,
        password: document.getElementById('password').value})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign in failed');
    location.assign('/');
  } catch (err) { error.textContent = err.message; }
  finally { button.disabled = false; }
});
