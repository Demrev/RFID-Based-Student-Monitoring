<<<<<<< HEAD
# ESP32 RFID Student Attendance — Node.js + MySQL + Dashboard

A local-network starter project based on your ESP32 + RC522 + 0.96-inch SSD1306 OLED (yellow/blue) + LEDs + buzzer setup. **Google Sheets is removed.** The ESP32 sends a scanned card's UID to a Node.js API; only the backend decides if the card is registered and saves attendance in MySQL. You register students through the dashboard.

## Folder contents

```text
ESP32_RFID_Node_MySQL_Dashboard/
├── README.md
├── database/
│   ├── schema.sql                 MySQL tables
│   └── optional_demo_students.sql Optional Jack/David test records
├── backend/
│   ├── package.json               npm dependencies
│   ├── .env.example               Config template (no real secrets)
│   ├── .gitignore
│   ├── lib.js
│   ├── server.js                  Express API and authentication
│   ├── test/lib.test.js           Small automated tests
│   └── public/                   Web dashboard + login + CSS + JavaScript
└── firmware/
    └── RFID_Node_MySQL_ESP32/
        └── RFID_Node_MySQL_ESP32.ino  Updated Arduino sketch
```

## Requirements

- ESP32 Dev Module (or compatible ESP32), RC522 RFID reader, 128x64 I2C SSD1306 OLED.
- Node.js **20+** and npm on the Windows computer that runs the backend.
- MySQL **8+** (e.g., via MySQL Workbench + MySQL Server) or a recent MariaDB build.
- ESP32 and Windows computer on the **same trusted Wi-Fi/local network** (clients must be able to reach each other; guest Wi-Fi client isolation must be off).
- Arduino IDE with ESP32 board package and these libraries: `MFRC522`, `Adafruit GFX Library`, `Adafruit SSD1306`, **`ArduinoJson` v7**.

## 1. Create your database

1. Start MySQL Server.
2. Open **MySQL Workbench** or **phpMyAdmin**.
3. Execute/import `database/schema.sql`. It creates the `rfid_attendance` database and three tables:
   - `students`: registered UIDs, student numbers, names, sections, and active status.
   - `attendance`: ENTRY and EXIT events with server-generated UTC timestamps.
   - `unknown_cards`: recently scanned UIDs not yet registered.
4. Optional: execute `database/optional_demo_students.sql` to register the two example UID/name pairs from the old sketch. The `DEMO-001` / `DEMO-002` student numbers are **samples**, not real student IDs; change them in your database if used.

> Recommended: create a dedicated MySQL account for this application instead of using `root` after initial testing. Do not expose the database port to the internet.

## 2. Configure and run Node.js on Windows

Open **PowerShell** or the **VS Code Terminal**, then go to the `backend` folder:

```powershell
cd C:\path\to\ESP32_RFID_Node_MySQL_Dashboard\backend
copy .env.example .env
notepad .env
```

Edit `.env`:

```dotenv
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=YOUR_MYSQL_PASSWORD
DB_NAME=rfid_attendance
ADMIN_USERNAME=admin
ADMIN_PASSWORD=MAKE_YOUR_OWN_STRONG_PASSWORD
SESSION_SECRET=MAKE_YOUR_OWN_LONG_RANDOM_SESSION_SECRET
DEVICE_API_KEY=MAKE_YOUR_OWN_LONG_RANDOM_DEVICE_KEY
SCAN_COOLDOWN_MS=5000
NODE_ENV=development
```

The values above are placeholders. Generate random secrets if possible:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Use **different** secrets for `SESSION_SECRET` and `DEVICE_API_KEY`. The session secret needs at least 32 characters, the device key at least 16, and the admin password at least 8. Keep the `.env` file private.

Then:

```powershell
npm install
npm start
```

Open on the Windows computer:

- Health check: `http://localhost:3000/api/health` (should show `"database":"connected"`)
- Dashboard: `http://localhost:3000` (sign in using the `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`)

**Leave the terminal running** while using the RFID reader. If you close it or turn off the PC, online attendance logging stops.

## 3. Find your Windows PC's local IPv4 address

In PowerShell or Command Prompt:

```powershell
ipconfig
```

Under the connected Wi-Fi/Ethernet adapter find **IPv4 Address**. For example it might be `192.168.1.100` (your actual address is likely different).

Use the PC address in the firmware URL, never `localhost` or `127.0.0.1`. If Windows Firewall prompts for access to Node.js, allow it **on Private networks only**. Do not forward port 3000 from your router to the public internet.

## 4. Upload the ESP32 firmware

Open `firmware/RFID_Node_MySQL_ESP32/RFID_Node_MySQL_ESP32.ino` in Arduino IDE. Change these lines:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* BACKEND_URL = "http://192.168.1.100:3000/api/device/scans";
const char* DEVICE_API_KEY = "PASTE_THE_DEVICE_API_KEY_FROM_BACKEND_DOT_ENV";
```

- Replace Wi-Fi name and password with your real 2.4GHz network credentials.
- Replace `192.168.1.100` with the **actual local IPv4 address of the computer running Node.js**.
- Paste the **exact same** `DEVICE_API_KEY` from the backend `.env` into the firmware.
- Install ArduinoJson **v7** if you do not have it yet.
- Select your ESP32 Dev Module and COM port; Verify, then Upload.
- Serial Monitor: **115200 baud**. An HTTP response of `200` means the backend accepted the request; `401` means device-key mismatch; negative status codes generally indicate connection problems; `500` means server/DB error.

**Wiring (same as your current project)**

| Component | ESP32 |
|---|---|
| OLED SDA | GPIO 4 |
| OLED SCK/SCL | GPIO 5 |
| RC522 SDA/SS | GPIO 21 |
| RC522 RST | GPIO 22 |
| RC522 SCK | GPIO 18 |
| RC522 MISO | GPIO 19 |
| RC522 MOSI | GPIO 23 |
| Green LED via its own 220Ω resistor | GPIO 25 |
| Red LED via its own 220Ω resistor | GPIO 26 |
| Buzzer control / appropriately rated transistor driver | GPIO 27 |
| OLED / RC522 supply | 3.3V and GND as required |

**Buzzer safety:** the buzzer type/rating is not confirmed. The sketch assumes an **active** buzzer (`BUZZER_IS_ACTIVE = true`). Use a properly rated driver transistor when needed; do not directly connect an unknown-current buzzer to a GPIO. If your buzzer is passive, switch `BUZZER_IS_ACTIVE = false` to use tones. Always power off the ESP32 when changing wiring.

## 5. Register students and test an RFID card

1. Open the web dashboard and sign in. Use the sidebar to switch between the overview, attendance, students, and unknown-card screens.
2. In **Register a student**, enter student number, full name, optional section, and the card UID, e.g. `E43E4101`.
3. Use **Edit**, **Enable/Disable**, or **Delete** in the Registered students table to manage records. Delete permanently removes the student and all of their attendance history; disable the student instead if you want to keep those records.
4. Scan that physical card. The ESP32 sends the UID to Node.js.
5. For registered active cards: **Green LED + 1 beep**, OLED shows name and **ENTRY** or **EXIT**, and the dashboard shows the event.
6. For cards not registered: **Red LED + 2 beeps** and OLED shows `UNKNOWN`. The UID appears in the **Unregistered cards** table; click **Register** to autofill the UID in the student form.
7. For inactive students: red LED + 2 beeps; **no attendance record**.
8. For duplicate scans inside the server's 5-second cooldown: OLED shows `WAIT`, with **no new record**.
9. The first accepted scan **each Philippine calendar day** is `ENTRY`; the next is `EXIT`, alternating for subsequent scans on the same day. The backend timestamps the events; the ESP32 no longer determines the event type.

The dashboard date picker, summary, attendance table and exported CSV display Philippine time (Asia/Manila, UTC+8). Scan times are stored in UTC in the database, so they remain unambiguous.

## API examples (optional)

Only the ESP32 (or a client possessing the device API key) can send scans. To test without the ESP32, use PowerShell:

```powershell
$headers = @{ "X-Device-Key" = "YOUR_DEVICE_API_KEY" }
$body = @{ uid = "E43E4101"; deviceId = "TEST-PC" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/device/scans" `
  -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

Example registered response:

```json
{"ok":true,"outcome":"recorded","registered":true,"name":"Jack","section":"BSIT 3A","uid":"E43E4101","event":"ENTRY"}
```

Example unregistered response:

```json
{"ok":true,"outcome":"unknown","registered":false,"name":"Unknown","uid":"ABCDEF12"}
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `database: unavailable` | Start MySQL; import `schema.sql`; correct `.env` credentials/DB name |
| ESP32 returns `-1` / cannot connect | Confirm the PC LAN IP, Windows private firewall rules, PC and ESP32 same reachable network, and `npm start` still running |
| ESP32 receives `401` | Make `DEVICE_API_KEY` in the `.ino` **exactly** match `.env` |
| ESP32 receives `500` | Check Node.js console for database connectivity/table errors |
| Card appears as `UNKNOWN` | Register its **exact UID** on the dashboard; UID uses hexadecimal, not student ID |
| Registered card returns `WAIT` | Wait at least 5 seconds since previous server-accepted scan |
| Only OLED clock works | Confirm RC522 SPI wiring and card frequency (RC522 reads compatible 13.56 MHz tags) |
| Arduino cannot find `ArduinoJson.h` | Install `ArduinoJson` via Arduino IDE Library Manager |
| No AM/PM time on OLED | ESP32 needs successful Wi-Fi + NTP sync |

## Security and deployment notes

This is a **local/trusted-network starter system**, not a production internet-hosted attendance product. The sample dashboard uses `express-session`'s **in-memory session store** (suitable only for development). HTTP on a LAN sends credentials/device keys without encryption. For internet or school-wide deployment: add HTTPS/TLS, a persistent session store, audit logs, role-based accounts, backups, HTTPS certificate validation on the ESP32, and an appropriate privacy/data-retention policy. RFID UIDs alone can be copied; this starter is **not** a strong physical access-control or anti-impersonation system. Avoid putting student personal details or API keys in public repositories.
=======
# RFID-Based-Student-Monitoring
>>>>>>> aa17454fb374e97b7cf74f8816219178291f10e1
