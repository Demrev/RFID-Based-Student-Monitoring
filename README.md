# RFID Based Attendance Monitoring

Express serves the login page, dashboard, admin API, and ESP32 scan endpoint. MySQL stores students, attendance, unknown cards, and admin sessions.

## Local development

1. Install Node.js 22 or newer and MySQL 8 / recent MariaDB.
2. Create the local database by importing `database/schema.sql`.
3. Copy `backend/.env.example` to `backend/.env` and fill in the database credentials, admin login, device key, and session secret. An existing `.env` can be kept.
4. Run `npm ci` and `npm start` from `backend/`.
5. Open `http://localhost:3000/login`.

Generate a random secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Generate separate values for the session secret and device API key. Never commit `.env`.

## Deploy on Railway

Host the backend and a MySQL service in the **same Railway project and environment**. The backend also hosts the website; a separate frontend service is unnecessary.

### Services and build settings

1. Create a project and add the official **MySQL** database service. Keep its service name `MySQL` for the variable references below.
2. Add an application service from your repository, `Demrev/RFID-Based-Student-Monitoring`. The deployment must include your current local changes; a GitHub deployment only sees committed and pushed files.
3. Set the application's **Root Directory** to `/backend` and its **Config File** path to `/backend/railway.json`.
4. Use **one application replica**. Database sessions persist across deployments; the current login and device rate limits are per process.

The checked-in configuration uses Railpack, `npm start`, and the `/api/health` health check. Railway supplies `PORT`; do not hardcode it. For a direct source upload, upload only the contents of `backend/` as the service root, with `/railway.json` as its config path. `.railwayignore` excludes local environment files and dependencies.

### Application variables

Set these in the **application service**, not in the MySQL service:

```dotenv
NODE_ENV=production
TRUST_PROXY_HOPS=1
DB_AUTO_INIT=true
DB_POOL_SIZE=5
DB_HOST=${{MySQL.MYSQLHOST}}
DB_PORT=${{MySQL.MYSQLPORT}}
DB_USER=${{MySQL.MYSQLUSER}}
DB_PASSWORD=${{MySQL.MYSQLPASSWORD}}
DB_NAME=${{MySQL.MYSQLDATABASE}}
ADMIN_USERNAME=your-admin-username
ADMIN_PASSWORD=your-strong-admin-password
SESSION_SECRET=your-random-secret-of-at-least-32-characters
DEVICE_API_KEY=your-random-device-key-of-at-least-16-characters
SCAN_COOLDOWN_MS=5000
```

Replace the four credential placeholders before deploying. Use Railway's private MySQL host for service-to-service traffic. Leave `DB_SSL` unset for the default private database connection; if your database provider requires TLS, set `DB_SSL=true` and provide its CA using `DB_SSL_CA` when needed. Certificate verification stays enabled.

`DB_AUTO_INIT=true` creates missing application tables inside the database selected by `DB_NAME`, without changing databases, dropping tables, or inserting demo students. The `admin_sessions` table is created automatically. Existing local data is not uploaded by this setup. To migrate existing records, import a database dump into the Railway database before switching devices over.

### Publish and verify

1. Deploy the application's staged settings and variables.
2. Under **Settings → Networking**, generate a public domain for the application.
3. Visit `https://<your-domain>/api/health`; it should return `{"ok":true,"database":"connected"}`. The check verifies that the application and session tables are available.
4. Sign in at `https://<your-domain>/login`, then test student registration and dashboard updates.
5. Redeploy once and confirm that the same browser remains signed in.

For deployment troubleshooting, inspect application logs. `DB_*` variables override the equivalent `MYSQL*` variables. A login that succeeds but immediately returns to the login page usually means the proxy setting, HTTPS, session secret, or session table needs checking.

### Connect the ESP32

The existing firmware uses a local **HTTP** URL and `WiFiClient`. Before connecting it to Railway:

- Set `BACKEND_URL` to `https://<your-domain>/api/device/scans`.
- Use `WiFiClientSecure` with a trusted root CA for the deployed site's certificate. Keep certificate verification enabled.
- Set `DEVICE_API_KEY` to the same value as the backend's Railway variable.
- Synchronize the device clock using NTP before the TLS connection, then upload the updated sketch to the ESP32.

Changing the URL alone is insufficient: the firmware still needs its HTTPS client and certificate configuration. The final domain and CA can be configured once the backend is live. Wi-Fi credentials remain on the device; they are not needed by Railway.

## Verification

From `backend/`:

```text
npm test
npm run check:production
node scripts/check-dashboard.cjs
npm audit --omit=dev
```

`check:production` requires access to a local MySQL account that can create and drop a database. It creates a randomly named `rfid_deploy_test_*` database, tests real login/session persistence and a device scan against a production-mode server, and removes only that test database afterward. It does not change the configured attendance database. `check-dashboard.cjs` uses isolated browser fixtures and requires Chrome (or `CHROME_PATH`).

Railway references: [MySQL](https://docs.railway.com/databases/mysql), [build settings](https://docs.railway.com/builds/build-configuration), [configuration as code](https://docs.railway.com/config-as-code), [variables](https://docs.railway.com/variables).
