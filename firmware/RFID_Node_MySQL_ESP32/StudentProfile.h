#pragma once
#include <Arduino.h>
#include <vector>

// Display hints only. The backend remains authoritative for access and attendance.
struct StudentProfile {
  String uid;
  String name;
  String section;
  bool active = true;
};
