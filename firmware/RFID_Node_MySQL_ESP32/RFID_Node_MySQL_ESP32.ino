/*
  ESP32 RFID Attendance System - Node.js + MySQL version
  RC522 -> backend validates UID -> MySQL records ENTRY/EXIT.
  SSD1306 (yellow/blue), red/green LEDs, buzzer, 12-hour Philippine clock.
  Install ArduinoJson v7, Adafruit SSD1306/GFX and MFRC522 libraries.
  Configure BACKEND_URL to your computer LAN IPv4 address, not localhost.
*/

//     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json

#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <Wire.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "time.h"
#include <ArduinoJson.h>
#include "ScanResult.h"

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

// Run the Node.js server on your PC connected to the SAME Wi-Fi.
// On Windows: run ipconfig, copy the PC's IPv4 address.
// Do not use localhost or 127.0.0.1 here; those point to the ESP32.
const char* BACKEND_URL = "http://192.168.101.7:3000/api/device/scans";
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
void setupTime() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
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

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(4000);  // Network trouble will still delay OLED feedback

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

  int statusCode = http.POST(requestBody);
  String body = statusCode > 0 ? http.getString() : "";
  Serial.printf("Backend HTTP status: %d\n", statusCode);
  if (statusCode != 200) {
    // Check backend logs for DB errors or an incorrect API key.
    Serial.println("Backend error: " + body);
    http.end();
    return result;
  }

  JsonDocument response;
  DeserializationError error = deserializeJson(response, body);
  if (error) {
    Serial.println("Invalid JSON response");
    http.end();
    return result;
  }

  result.outcome = String(response["outcome"] | "error");
  result.name = String(response["name"] | "");
  result.section = String(response["section"] | "");
  result.eventType = String(response["event"] | "");
  result.serverOk = (response["ok"] | false);
  http.end();
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

void showCenteredFitText(const String &text, int y) {
  display.setTextSize(1);
  String visible = text;
  int16_t x1, y1;
  uint16_t w, h;
  while (visible.length() > 0) {
    display.getTextBounds(visible, 0, 0, &x1, &y1, &w, &h);
    if (w <= SCREEN_WIDTH - 4) break;
    visible.remove(visible.length() - 1);
  }
  centerText(visible, y, 1);
}

void showRFIDScreen(const String &status, const String &name, const String &section = "") {
  display.clearDisplay(); const int bandH = 18; display.fillRect(0, 0, SCREEN_WIDTH, bandH, SSD1306_WHITE);
  display.setTextSize(1); display.setTextColor(SSD1306_BLACK);
  centerText(status, (bandH - 8) / 2, 1);
  display.setTextColor(SSD1306_WHITE);
  showCenteredFitText(name, 26);
  if (section.length()) showCenteredFitText(section, 43);
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
      showRFIDScreen("CHECKING", "Please wait");

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
        delay(1000);
        turnOffStatusLEDs();
      } else if (result.outcome == "unknown" || result.outcome == "inactive") {
        showRFIDScreen(result.outcome == "inactive" ? "INACTIVE" : "UNKNOWN", result.name);
        setStatusLEDs(false);       // red LED
        beepUnknownCard();          // two beeps
        delay(900);
        turnOffStatusLEDs();
      } else if (result.outcome == "cooldown") {
        showRFIDScreen("WAIT", "Scan later");
        delay(650);                 // no LED or buzzer, no new record
      } else {
        showRFIDScreen("SERVER ERROR", "Try again");
        delay(900);
      }
    }
  }

  delay(80);
}
