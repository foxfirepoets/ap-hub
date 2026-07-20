-- Reversal for 007_tax_dimension_mapping.sql. Drops tables in dependency order
-- (children before parents); indexes and partial-unique indexes drop with their tables.
-- Fully reverses UP; UP -> DOWN -> UP is clean.

DROP TABLE IF EXISTS dimension_mapping_rules;  -- FK -> dimension_mappings, connections, tenants
DROP TABLE IF EXISTS dimension_mappings;       -- FK -> proposals, connections, tenants
DROP TABLE IF EXISTS tax_mapping_audit;        -- FK -> tax_mappings, users, connections, tenants
DROP TABLE IF EXISTS tax_mappings;             -- self-ref, FK -> connections, tenants
