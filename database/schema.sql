-- Run in MySQL 8.0+ or recent MariaDB using MySQL Workbench/phpMyAdmin.
-- Store scan timestamps as UTC DATETIME(3). Dashboard displays Asia/Manila time.
CREATE DATABASE IF NOT EXISTS rfid_attendance
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rfid_attendance;

CREATE TABLE IF NOT EXISTS students (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_no VARCHAR(40) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  section VARCHAR(80) DEFAULT NULL,
  uid VARCHAR(20) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_student_no (student_no),
  UNIQUE KEY uq_card_uid (uid)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attendance (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id BIGINT UNSIGNED NOT NULL,
  uid VARCHAR(20) NOT NULL,
  event_type ENUM('ENTRY', 'EXIT') NOT NULL,
  device_id VARCHAR(50) NOT NULL,
  scanned_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_student_latest (student_id, id),
  KEY idx_scan_time (scanned_at, id),
  CONSTRAINT fk_attendance_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;

-- Optional audit for new/unregistered card UIDs to simplify enrollment.
CREATE TABLE IF NOT EXISTS unknown_cards (
  uid VARCHAR(20) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  scan_count INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (uid),
  KEY idx_unknown_last_seen (last_seen_at)
) ENGINE=InnoDB;
