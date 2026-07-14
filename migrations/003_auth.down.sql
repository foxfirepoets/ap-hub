-- Reversal for 003_auth.sql. Drops sessions before users (FK order).
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
