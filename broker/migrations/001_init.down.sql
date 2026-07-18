-- DOWN for 001_init (SPEC §13-B). Safe: all three tables are created by this
-- migration and nothing else references them. DROP is acceptable here only because
-- the tables are new in this migration — there are no live references to check.
DROP TABLE IF EXISTS spend_ledger;
DROP TABLE IF EXISTS heartbeats;
DROP TABLE IF EXISTS installs;
