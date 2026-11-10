-- OPTIONAL sample student records copied from your earlier ESP32 uidToName map.
-- Replace the demonstration student numbers with real identifiers before use.
USE rfid_attendance;
INSERT INTO students (student_no, full_name, section, uid, created_at)
VALUES ('DEMO-001', 'Jack', 'Demo', 'E43E4101', UTC_TIMESTAMP(3)),
       ('DEMO-002', 'David', 'Demo', '331BFC2C', UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE full_name=VALUES(full_name);
