#pragma once

#include <Arduino.h>

struct ScanResult {
  bool serverOk = false;
  String outcome = "error";
  String name = "";
  String section = "";
  String eventType = "";
};
