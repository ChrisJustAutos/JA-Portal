/*  ============================================================================
    JA Scale Node — live bin inventory (load cell → HX711 → ESP32 → JA Portal)
    ----------------------------------------------------------------------------
    Reads one or more HX711 load-cell amplifiers and POSTs RAW counts to the
    portal every REPORT_MS (or immediately on a significant change). All
    calibration (tare, grams-per-count, unit weights, part/bin numbers) lives
    SERVER-side — configure it at Workshop → Inventory → Live Bins. Reflashing
    is never needed for calibration changes.

    Hardware : ESP32 dev board + HX711 board(s) + load cell(s)
    Wiring   : HX711 VCC→3V3, GND→GND, DT/SCK per CELL_PINS below.
               Load cell: red→E+, black→E-, white→A-, green→A+ (typical 4-wire)
    Library  : "HX711" by Bogdan Necula (bogde) — Library Manager
    Setup    : 1) Portal → Live Bins → ⚙ Setup → + Add module → copy device key
               2) Fill in WIFI_SSID/WIFI_PASS/DEVICE_KEY below, flash
               3) Portal: Tare (bin empty) → Calibrate (known weight) →
                  set g/unit + part + bin number. Done.
    ============================================================================ */

#include <WiFi.h>
#include <HTTPClient.h>
#include "HX711.h"

// ── CONFIG ──────────────────────────────────────────────────────────────
// WiFi + device key live in secrets.h (gitignored) — copy secrets.example.h
// to secrets.h and fill in your values.
#include "secrets.h"
const char* INGEST_URL = "https://justautos.app/api/scales/ingest";
const char* FIRMWARE   = "scale-node-1.1";

// One entry per load cell / HX711 on this module: {DT pin, SCK pin}.
// Channel numbers in the portal follow array order (0, 1, 2 …).
#ifdef ARDUINO_NANO_ESP32
// Arduino Nano ESP32 (USB 2341:0070): GPIO16/17 aren't on the headers —
// wire HX711 DT→D2 and SCK→D3 (second cell: D4/D5).
const int CELL_PINS[][2] = {
  {D2, D3},        // channel 0
  // {D4, D5},     // channel 1 — uncomment for a second cell
};
#else
// Generic ESP32 WROOM dev board.
const int CELL_PINS[][2] = {
  {16, 17},        // channel 0
  // {18, 19},     // channel 1 — uncomment for a second cell
};
#endif
const int N_CELLS = sizeof(CELL_PINS) / sizeof(CELL_PINS[0]);

const uint32_t SAMPLE_MS     = 400;     // read cadence (HX711 delivers ~10 samples/s)
const uint32_t REPORT_MS     = 30000;   // heartbeat post interval
const long     DELTA_TRIGGER = 400;     // raw counts of change that post immediately (~1 g on a ~360 counts/g cell)
const int      AVG_SAMPLES   = 8;       // HX711 averaging per read (~0.8 s per reading)

// ── STATE ───────────────────────────────────────────────────────────────
HX711 cells[8];
long lastSent[8];
uint32_t lastPost = 0;

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);
}

bool postReadings(long raw[], bool ok[]) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.begin(INGEST_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);
  String body = "{\"firmware\":\"" + String(FIRMWARE) + "\",\"rssi\":" + String(WiFi.RSSI()) + ",\"readings\":[";
  bool first = true;
  for (int i = 0; i < N_CELLS; i++) {
    if (!ok[i]) continue;
    if (!first) body += ",";
    body += "{\"channel\":" + String(i) + ",\"raw\":" + String(raw[i]) + "}";
    first = false;
  }
  body += "]}";
  int code = http.POST(body);
  http.end();
  Serial.printf("[post] HTTP %d  %s\n", code, body.c_str());
  return code >= 200 && code < 300;
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < N_CELLS; i++) {
    cells[i].begin(CELL_PINS[i][0], CELL_PINS[i][1]);
    lastSent[i] = LONG_MIN;
  }
  connectWifi();
}

void loop() {
  static long raw[8];
  static bool ok[8];
  bool changed = false;

  for (int i = 0; i < N_CELLS; i++) {
    ok[i] = cells[i].wait_ready_timeout(1000);
    if (!ok[i]) { Serial.printf("[cell %d] not ready\n", i); continue; }
    raw[i] = cells[i].read_average(AVG_SAMPLES);
    if (labs(raw[i] - lastSent[i]) >= DELTA_TRIGGER) changed = true;
  }

  const bool heartbeat = millis() - lastPost >= REPORT_MS;
  if (changed || heartbeat) {
    connectWifi();
    if (postReadings(raw, ok)) {
      lastPost = millis();
      for (int i = 0; i < N_CELLS; i++) if (ok[i]) lastSent[i] = raw[i];
    }
  }
  delay(SAMPLE_MS);
}
