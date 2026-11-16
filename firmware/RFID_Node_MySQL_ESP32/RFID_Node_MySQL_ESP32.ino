/*
  ESP32 RFID Attendance System - Node.js + MySQL version
  RC522 -> backend validates UID -> MySQL records ENTRY/EXIT.
  SSD1306 (yellow/blue), red/green LEDs, buzzer, 12-hour Philippine clock.
  Install ArduinoJson v7, Adafruit SSD1306/GFX and MFRC522 libraries.
  Railway HTTPS backend; verify its certificate using RailwayCertificate.h.
*/

//     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <Wire.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "time.h"
#include <ArduinoJson.h>
#include "ScanResult.h"
#include "RailwayCertificate.h"
#include "StudentProfile.h"
#include "freertos/semphr.h"

// ------------------------
// Display configuration
// ------------------------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ------------------------
// RFID pins
// ------------------------
constexpr uint8_t SS_PIN = 21;
constexpr uint8_t RST_PIN = 22;
MFRC522 rfid(SS_PIN, RST_PIN);

// ------------------------
// Buzzer: GPIO 27
// ------------------------
// Set true for an ACTIVE buzzer (beeps from steady power).
// Set false for a PASSIVE buzzer (needs a tone signal).
constexpr uint8_t BUZZER_PIN = 27;
constexpr bool BUZZER_IS_ACTIVE = true;

void beepOnce(unsigned int frequencyHz, unsigned long durationMs) {
  if (BUZZER_IS_ACTIVE) {
    digitalWrite(BUZZER_PIN, HIGH);
  } else {
    tone(BUZZER_PIN, frequencyHz);
  }

  delay(durationMs);

  if (BUZZER_IS_ACTIVE) {
    digitalWrite(BUZZER_PIN, LOW);
  } else {
    noTone(BUZZER_PIN);
  }
}

void beepRegisteredCard() {
  beepOnce(2000, 120);  // one short beep
}

void beepUnknownCard() {
  beepOnce(1000, 160);  // two short beeps
  delay(100);
  beepOnce(1000, 160);
}

// ------------------------
// Status LEDs (each LED needs its own 220-ohm resistor)
// Green LED: GPIO 25 -> 220 ohms -> LED (+), LED (-) -> GND
// Red LED:   GPIO 26 -> 220 ohms -> LED (+), LED (-) -> GND
// ------------------------
constexpr uint8_t GREEN_LED_PIN = 25;
constexpr uint8_t RED_LED_PIN   = 26;

void setStatusLEDs(bool isRegistered) {
  digitalWrite(GREEN_LED_PIN, isRegistered ? HIGH : LOW);
  digitalWrite(RED_LED_PIN, isRegistered ? LOW : HIGH);
}

void turnOffStatusLEDs() {
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);
}

// ------------------------
// Wi-Fi + Node.js backend (EDIT THESE VALUES)
// ------------------------
const char* WIFI_SSID = "MONICA _2.4G";
const char* WIFI_PASSWORD = "Butchay1222";

// The ESP32 needs internet access. Match DEVICE_API_KEY to Railway's variable.
const char* BACKEND_URL = "https://rfid-based-student-monitoring-production.up.railway.app/api/device/scans";
const char* DEVICE_API_KEY = "db3372cb1d402cd088e5f9baa481ed6f";
const char* DEVICE_ID = "ESP32-01";

// ------------------------
// Time (NTP)
// ------------------------
// Philippine Standard Time (PHT)
const char* NTP_SERVER = "pool.ntp.org";
const long GMT_OFFSET_SEC = 28800; // UTC+8 Philippines
const int DAYLIGHT_OFFSET_SEC = 0;

// ------------------------
// UI & debounce timing
// ------------------------
static const unsigned long SCAN_DEBOUNCE_MS = 2500UL;
static const unsigned long COLON_BLINK_MS = 500UL;
static const unsigned long SCAN_ANIM_INTERVAL = 500UL;

unsigned long lastColonToggle = 0;
bool colonVisible = true;

String lastSeenUID = "";
unsigned long lastSeenMillis = 0;

int animation_state = 0;
unsigned long scanAnimLastMillis = 0;

bool prevWiFiConnected = false;
unsigned long lastWiFiRetry = 0;

constexpr size_t MAX_CACHED_STUDENTS = 256;
std::vector<StudentProfile> studentProfiles;
SemaphoreHandle_t profileMutex = nullptr;
SemaphoreHandle_t networkMutex = nullptr;

// ------------------------
// Utility helpers
// ------------------------
void centerText(const String &text, int y, int size = 1) {
  int16_t x1, y1; uint16_t w, h;
  display.setTextSize(size);
  display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  display.setCursor(max(0, (SCREEN_WIDTH - (int)w) / 2), y);
  display.print(text);
}

// OLED clock: 12-hour Philippine time with AM/PM.
// MySQL stores scan times from the server in UTC; dashboard shows PHT.
bool getHourMinute(String &hh, String &mm, String &ampm) {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 150)) return false;

  int hour12 = timeinfo.tm_hour % 12;
  if (hour12 == 0) hour12 = 12;  // midnight/noon
  ampm = (timeinfo.tm_hour < 12) ? "AM" : "PM";

  char buf[3];
  snprintf(buf, sizeof(buf), "%02d", hour12);
  hh = String(buf);
  snprintf(buf, sizeof(buf), "%02d", timeinfo.tm_min);
  mm = String(buf);
  return true;
}

String getDateString() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 150)) return String("--/--/--");
  char buffer[9]; strftime(buffer, sizeof(buffer), "%d/%m/%y", &timeinfo);
  return String(buffer);
}

// ------------------------
// Display helpers
// ------------------------
void drawWiFiIcon(bool connected) {
  int x = SCREEN_WIDTH - 18;
  display.fillRect(x, 0, 18, 12, SSD1306_BLACK);
  display.setTextColor(SSD1306_WHITE);
  display.drawPixel(x + 9, 6, SSD1306_WHITE);
  display.drawCircleHelper(x + 9, 6, 2, 0x1, SSD1306_WHITE);
  display.drawCircleHelper(x + 9, 6, 4, 0x1, SSD1306_WHITE);
  display.drawCircleHelper(x + 9, 6, 6, 0x1, SSD1306_WHITE);
  if (!connected) {
    display.drawLine(x + 5, 2, x + 13, 10, SSD1306_WHITE);
  }
}

void drawTimeBlinking(int y, int textSize = 3) {
  if (millis() - lastColonToggle >= COLON_BLINK_MS) {
    colonVisible = !colonVisible;
    lastColonToggle = millis();
  }

  String hh, mm, ampm;
  if (!getHourMinute(hh, mm, ampm)) {
    hh = "--";
    mm = "--";
    ampm = "";  // Wait for Wi-Fi/NTP synchronization
  }
  String timeStr = colonVisible ? hh + ":" + mm : hh + " " + mm;

  // Large clock and small AM/PM label fit side-by-side on a 128x64 OLED.
  display.setTextSize(textSize);
  int16_t x1, y1;
  uint16_t clockW, clockH;
  display.getTextBounds(timeStr, 0, 0, &x1, &y1, &clockW, &clockH);

  const int gap = 4;
  const int ampmW = ampm.length() ? 12 : 0; // 2 characters at text size 1
  const int totalW = clockW + (ampmW ? gap + ampmW : 0);
  const int x = max(0, (SCREEN_WIDTH - totalW) / 2);

  display.setCursor(x, y);
  display.print(timeStr);

  if (ampmW) {
    display.setTextSize(1);
    display.setCursor(x + clockW + gap, y + clockH - 8);
    display.print(ampm);
  }
}

// ------------------------
// RFID
// ------------------------
bool readRFID(String &uidOut) {
  if (!rfid.PICC_IsNewCardPresent()) return false;
  if (!rfid.PICC_ReadCardSerial()) return false;
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    char buf[3]; sprintf(buf, "%02X", rfid.uid.uidByte[i]); uid += buf;
  }
  uid.toUpperCase(); uidOut = uid;
  rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
  return true;
}

// ------------------------
// Networking & logging
// ------------------------
bool findStudentProfile(const String &uid, StudentProfile &profile) {
  if (!profileMutex) return false;
  bool found = false;
  xSemaphoreTake(profileMutex, portMAX_DELAY);
  for (const auto &item : studentProfiles) {
    if (item.uid == uid) { profile = item; found = true; break; }
  }
  xSemaphoreGive(profileMutex);
  return found;
}

void rememberStudentProfile(const String &uid, const ScanResult &result) {
  if (!profileMutex) return;
  xSemaphoreTake(profileMutex, portMAX_DELAY);
  // Remove stale identities after the server reports that a card is unknown.
  for (auto item = studentProfiles.begin(); item != studentProfiles.end(); ++item) {
    if (item->uid != uid) continue;
    if (result.outcome == "unknown") studentProfiles.erase(item);
    else if (result.name.length()) { item->name = result.name.substring(0, 120); item->section = result.section.substring(0, 80); }
    xSemaphoreGive(profileMutex);
    return;
  }
  if (result.outcome != "unknown" && result.name.length() && studentProfiles.size() < MAX_CACHED_STUDENTS) {
    studentProfiles.push_back({uid, result.name.substring(0, 120), result.section.substring(0, 80)});
  }
  xSemaphoreGive(profileMutex);
}

void syncStudentProfiles() {
  if (WiFi.status() != WL_CONNECTED || !networkMutex || !profileMutex) return;
  struct tm clock;
  if (!getLocalTime(&clock, 1)) return;
  std::vector<StudentProfile> fresh;
  String endpoint = BACKEND_URL;
  const int suffix = endpoint.lastIndexOf("/scans");
  if (suffix < 0) return;
  endpoint = endpoint.substring(0, suffix) + "/students";
  String cursor = "0";
  while (fresh.size() < MAX_CACHED_STUDENTS) {
    // Only one TLS connection uses memory at a time; yield to foreground scans.
    if (xSemaphoreTake(networkMutex, 0) != pdTRUE) return;
    WiFiClientSecure client;
    client.setCACert(RAILWAY_ROOT_CA);
    client.setHandshakeTimeout(8);
    HTTPClient http;
    http.setConnectTimeout(8000);
    http.setTimeout(5000);
    http.useHTTP10(true); // A plain response stream is easy to parse without a body copy.
    bool valid = http.begin(client, endpoint + "?after=" + cursor);
    JsonDocument document;
    if (valid) {
      http.addHeader("X-Device-Key", DEVICE_API_KEY);
      valid = http.GET() == 200;
      if (valid) valid = !deserializeJson(document, http.getStream());
    }
    http.end();
    xSemaphoreGive(networkMutex);
    if (!valid || !document["rows"].is<JsonArray>()) {
      Serial.println("Student cache sync unavailable; scan lookup remains available");
      return; // Keep the last complete cache on network errors.
    }
    for (JsonObject row : document["rows"].as<JsonArray>()) {
      if (fresh.size() >= MAX_CACHED_STUDENTS) break;
      String uid = row["uid"] | "";
      String name = row["name"] | "";
      String section = row["section"] | "";
      if (uid.length() && name.length()) fresh.push_back({uid, name.substring(0, 120), section.substring(0, 80)});
    }
    if (document["nextCursor"].isNull()) break;
    String nextCursor = document["nextCursor"].as<String>();
    if (!nextCursor.length() || nextCursor == cursor) return;
    cursor = nextCursor;
    vTaskDelay(pdMS_TO_TICKS(50));
  }
  xSemaphoreTake(profileMutex, portMAX_DELAY);
  studentProfiles.swap(fresh);
  const size_t count = studentProfiles.size();
  xSemaphoreGive(profileMutex);
  Serial.printf("Student display cache ready: %u profiles\n", (unsigned)count);
}

void studentProfileTask(void *parameter) {
  for (;;) {
    syncStudentProfiles();
    // Frequent short retries until NTP/initial profiles are available.
    xSemaphoreTake(profileMutex, portMAX_DELAY);
    const bool empty = studentProfiles.empty();
    xSemaphoreGive(profileMutex);
    vTaskDelay(pdMS_TO_TICKS(empty ? 5000 : 30000));
  }
}

void setupTime() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER, "time.google.com", "time.cloudflare.com");
}

void connectToWiFi(unsigned long timeoutMs = 10000) {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(200);
  }
}

ScanResult sendCardToBackend(const String &uid) {
  ScanResult result;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot scan: Wi-Fi disconnected");
    return result;
  }

  // Certificate validation needs the correct date. NTP starts on Wi-Fi connection.
  struct tm tlsTime;
  if (!getLocalTime(&tlsTime, 10000)) {
    Serial.println("Cannot scan: waiting for internet time synchronization");
    return result;
  }

  WiFiClientSecure client;
  client.setCACert(RAILWAY_ROOT_CA);
  client.setHandshakeTimeout(12);
  HTTPClient http;
  http.setConnectTimeout(12000);
  http.setTimeout(10000);  // Allow time for the internet connection to Railway.

  if (!http.begin(client, BACKEND_URL)) {
    Serial.println("Cannot connect to backend URL");
    return result;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);

  JsonDocument request;
  request["uid"] = uid;
  request["deviceId"] = DEVICE_ID;
  String requestBody;
  serializeJson(request, requestBody);

  if (networkMutex) xSemaphoreTake(networkMutex, portMAX_DELAY);
  int statusCode = http.POST(requestBody);
  String body = statusCode > 0 ? http.getString() : "";
  Serial.printf("Backend HTTP status: %d\n", statusCode);
  if (statusCode != 200) {
    // Check backend logs for DB errors or an incorrect API key.
    Serial.println("Backend error: " + body);
    if (statusCode < 0) Serial.println("Network/TLS error: " + http.errorToString(statusCode));
    http.end();
    if (networkMutex) xSemaphoreGive(networkMutex);
    return result;
  }

  JsonDocument response;
  DeserializationError error = deserializeJson(response, body);
  if (error) {
    Serial.println("Invalid JSON response");
    http.end();
    if (networkMutex) xSemaphoreGive(networkMutex);
    return result;
  }

  result.outcome = String(response["outcome"] | "error");
  result.name = String(response["name"] | "");
  result.section = String(response["section"] | "");
  result.eventType = String(response["event"] | "");
  result.serverOk = (response["ok"] | false);
  http.end();
  if (networkMutex) xSemaphoreGive(networkMutex);
  if (result.serverOk) rememberStudentProfile(uid, result);
  return result;
}

// ------------------------
// UI screens
// ------------------------
void showStartingScreenAnimated(const String &staticText, unsigned long animationTickMs = 500) {
  static unsigned long lastAnimUpdate = 0;
  static int connectAnimState = 0;
  if (millis() - lastAnimUpdate > animationTickMs) {
    connectAnimState = (connectAnimState + 1) % 4; lastAnimUpdate = millis();
  }
  display.clearDisplay(); display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2); centerText(staticText, 18);
  display.setTextSize(1);
  String connectLine = "Connecting";
  for (int i = 0; i < connectAnimState; ++i) connectLine += ".";
  centerText(connectLine, 42);
  display.display();
}

void showWifiConnectedMessage(unsigned long showMs = 1200) {
  display.clearDisplay(); display.setTextSize(2); display.setTextColor(SSD1306_WHITE);
  centerText("WiFi Connected", 26); display.display(); delay(showMs);
}

void showWiFiConnectingScreen() {
  display.clearDisplay(); display.setTextColor(SSD1306_WHITE);
  drawWiFiIcon(false); drawTimeBlinking(20, 3);
  display.setTextSize(1); centerText("WiFi Disconnected", 44, 1);
  String anim = "Connecting";
  for (int i = 0; i < animation_state; i++) anim += ".";
  centerText(anim, 54, 1);
  display.display();
  if (millis() - scanAnimLastMillis > 500) { animation_state = (animation_state + 1) % 4; scanAnimLastMillis = millis(); }
}

void showDefaultScreen() {
  display.clearDisplay(); bool connected = (WiFi.status() == WL_CONNECTED);
  drawWiFiIcon(connected); display.setTextSize(3); display.setTextColor(SSD1306_WHITE);
  drawTimeBlinking(12, 3);

  const int barY = 48, barH = 16, leftBoxW = 62, rightBoxW = 66;
  display.fillRect(0, barY, SCREEN_WIDTH, barH, SSD1306_BLACK);
  display.drawRect(0, barY, leftBoxW, barH, SSD1306_WHITE);
  display.drawRect(leftBoxW, barY, rightBoxW, barH, SSD1306_WHITE);

  String dateStr = getDateString(); display.setTextSize(1);
  int16_t x1, y1; uint16_t w, h; display.getTextBounds(dateStr.c_str(), 0, 0, &x1, &y1, &w, &h);
  int leftBoxCenterX = leftBoxW / 2; int dateX = leftBoxCenterX - (w / 2);
  int dateY = barY + ((barH - h) / 2); if (dateX < 1) dateX = 1;
  display.setCursor(dateX, dateY); display.print(dateStr);

  String scanText = (animation_state == 0) ? "SCAN" : (animation_state == 1) ? "SCAN." : (animation_state == 2) ? "SCAN.." : "SCAN...";
  display.getTextBounds(scanText.c_str(), 0, 0, &x1, &y1, &w, &h);
  int rightBoxX = leftBoxW; int rightBoxCenterX = rightBoxX + (rightBoxW / 2);
  int scanX = rightBoxCenterX - (w / 2); int scanY = barY + ((barH - h) / 2);
  if (scanX < rightBoxX + 1) scanX = rightBoxX + 1; display.setCursor(scanX, scanY);
  display.print(scanText);

  if (millis() - scanAnimLastMillis > SCAN_ANIM_INTERVAL) { animation_state = (animation_state + 1) % 4; scanAnimLastMillis = millis(); }
  display.display();
}

void drawFittedBlock(const String &text, int top, int height) {
  String value = text;
  value.replace('\n', ' ');
  value.replace('\r', ' ');
  value.trim();
  if (!value.length()) return;
  // The built-in font is 6x8 pixels. Short text gets 2x size; long text wraps.
  if (value.length() <= 10 && height >= 16) {
    centerText(value, top + (height - 16) / 2, 2);
    return;
  }
  const int columns = (SCREEN_WIDTH - 8) / 6; // 20 characters, 4px side margins.
  String lines[2];
  int count = 0;
  while (value.length() && count < 2) {
    int take = min((int)value.length(), columns);
    if ((int)value.length() > columns) {
      int space = value.lastIndexOf(' ', columns);
      if (space > 0) take = space;
    }
    lines[count] = value.substring(0, take);
    value = value.substring(take);
    value.trim();
    if (count == 1 && value.length()) {
      lines[count] = lines[count].substring(0, columns - 3) + "...";
    }
    count++;
  }
  const int lineHeight = 9;
  const int firstY = top + (height - (count * lineHeight - 1)) / 2;
  for (int line = 0; line < count; line++) centerText(lines[line], firstY + line * lineHeight, 1);
}

void showRFIDScreen(const String &status, const String &name, const String &section = "") {
  display.clearDisplay(); const int bandH = 16; display.fillRect(0, 0, SCREEN_WIDTH, bandH, SSD1306_WHITE);
  display.setTextSize(1); display.setTextColor(SSD1306_BLACK);
  centerText(status, (bandH - 8) / 2, 1);
  display.setTextColor(SSD1306_WHITE);

  if (section.length()) {
    drawFittedBlock(name, 19, 21);
    display.drawFastHLine(14, 41, SCREEN_WIDTH - 28, SSD1306_WHITE);
    drawFittedBlock(section, 44, 18);
  } else {
    drawFittedBlock(name, 24, 30);
  }
  display.display();
}

// ------------------------
// Arduino core
// ------------------------
void setup() {
  Serial.begin(115200);
  // GPIO 27 controls the buzzer or its transistor driver.
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);

  // Both LEDs are off until a card is scanned.
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(RED_LED_PIN, OUTPUT);

  // Same SDA/SCL pins and SSD1306 initialization as the working OLED test.
  Wire.begin(4, 5);  // SDA = GPIO 4, SCL (OLED SCK) = GPIO 5
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println("SSD1306 OLED not found! Check wiring and I2C address.");
    while (true) { delay(1000); }
  }
  Serial.println("SSD1306 OLED detected!");
  display.clearDisplay();
  display.setRotation(0);
  display.setTextWrap(false); // All scan text is explicitly fitted to the display.
  display.setTextColor(SSD1306_WHITE);
  display.display();

  // Explicit default ESP32 SPI pin mapping for RC522.
  SPI.begin(18, 19, 23, SS_PIN);
  rfid.PCD_Init();

  lastColonToggle = scanAnimLastMillis = millis();

  // Start WiFi (non-blocking initial animation)
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < 8000) {
    showStartingScreenAnimated("Starting...", 400);
    delay(40);
  }

  if (WiFi.status() == WL_CONNECTED) {
    setupTime(); showWifiConnectedMessage(1200); prevWiFiConnected = true;
  }
  profileMutex = xSemaphoreCreateMutex();
  networkMutex = xSemaphoreCreateMutex();
  if (profileMutex && networkMutex) {
    if (xTaskCreate(studentProfileTask, "student-cache", 8192, nullptr, 1, nullptr) != pdPASS) {
      Serial.println("Student cache task could not start; scan lookup remains available");
    }
  }
}

void loop() {
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);

  // If disconnected, try reconnecting periodically and show connecting UI
  if (!wifiConnected) {
    if (millis() - lastWiFiRetry > 5000) { connectToWiFi(3000); lastWiFiRetry = millis(); }
    showWiFiConnectingScreen(); delay(120); return;
  }

  if (!prevWiFiConnected && wifiConnected) { setupTime(); showWifiConnectedMessage(1000); }
  prevWiFiConnected = wifiConnected;

  showDefaultScreen();

  String uid;
  if (readRFID(uid)) {
    Serial.println("RFID UID: " + uid);
    unsigned long now = millis();
    if (uid == lastSeenUID && (now - lastSeenMillis) < SCAN_DEBOUNCE_MS) {
      Serial.println("Duplicate scan ignored locally");
    } else {
      lastSeenUID = uid;
      lastSeenMillis = now;
      StudentProfile profile;
      if (findStudentProfile(uid, profile)) {
        // Identity appears immediately. No green LED/beep until Railway saves it.
        showRFIDScreen("CARD SCANNED", profile.name, profile.section);
      }

      // Backend handles student lookup, 5-second cooldown, and ENTRY/EXIT.
      ScanResult result = sendCardToBackend(uid);
      if (!result.serverOk) {
        Serial.println("Scan NOT saved: backend unavailable");
        showRFIDScreen("SERVER ERROR", "Not saved");
        setStatusLEDs(false);
        beepUnknownCard();
        delay(900);
        turnOffStatusLEDs();
      } else if (result.outcome == "recorded" &&
                 (result.eventType == "ENTRY" || result.eventType == "EXIT")) {
        Serial.println("Saved " + result.eventType + " for " + result.name);
        showRFIDScreen(result.eventType, result.name, result.section);
        setStatusLEDs(true);        // green LED
        beepRegisteredCard();       // single beep
        delay(1800);                // Give wrapped names/courses time to be read.
        turnOffStatusLEDs();
      } else if (result.outcome == "unknown" || result.outcome == "inactive") {
        showRFIDScreen(result.outcome == "inactive" ? "INACTIVE" : "UNKNOWN", result.name, result.section);
        setStatusLEDs(false);       // red LED
        beepUnknownCard();          // two beeps
        delay(900);
        turnOffStatusLEDs();
      } else if (result.outcome == "cooldown") {
        showRFIDScreen("ALREADY SCANNED", result.name, result.section);
        delay(650);                 // no LED or buzzer, no new record
      } else {
        showRFIDScreen("SERVER ERROR", "Try again");
        delay(900);
      }
    }
  }

  delay(80);
}
