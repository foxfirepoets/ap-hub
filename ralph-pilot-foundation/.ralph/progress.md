# Progress Log (append-only)

Project: ap-hub-pilot-foundation
Initialized: 2026-07-17
Total chunks: 8

## Log

(no entries yet)

[2026-07-17T13:31:00Z] CHUNK_1_BASELINE task 1: verify green baseline + fix .env.example port drift — DONE (212/212, lint/typecheck/web:build green)
<promise>CHUNK COMPLETE: CHUNK_1_BASELINE</promise>

[2026-07-18T04:37:00Z] CHUNK_2_BROKERAUTH: broker service skeleton + per-install token auth — DONE. broker/ package (node:http, Zod, Pino, pg), migrations 001 UP/DOWN (verify=3), token issue/revoke/list CLI, bearer auth (401/401/403/200), /health. broker tests 18/18 green; typecheck green; ap-hub suite still 212/212; only broker/ added.
<promise>CHUNK COMPLETE: CHUNK_2_BROKERAUTH</promise>

[2026-07-18T04:55:00Z] CHUNK_3_BROKERPROXY: fail-closed proxy (/v1/extract→Anthropic, /api/verify, /api/scan/invoices, /api/proof/:id/export/verify→SwarmSync), per-install spend cap + rate limit — DONE. broker 27/27 (9 new proxy tests: verbatim passthrough, non-2xx→502, throw→502, empty-200 relayed, cap→429 upstream-not-called, ratelimit→429, malformed→400, db-down→503, chain-verify). ap-hub 212/212; lint/typecheck/web:build green. Note: repointed one CHUNK_2 placeholder broker test (/v1/extract 501 → /v1/heartbeat 501) since /v1/extract is now implemented; additive test helpers. No ap-hub test or src/qbo/write.ts touched.
<promise>CHUNK COMPLETE: CHUNK_3_BROKERPROXY</promise>

[2026-07-18T05:05:00Z] CHUNK_4_BROKERMODE: ap-hub broker-mode rewiring — DONE. config BROKER_BASE_URL (https-validated)+BROKER_INSTALL_TOKEN, ANTHROPIC/SWARMSYNC optional in broker mode (required direct); getBrokerExtractor+getExtractor (shared buildAnthropicRequest); services.ts broker-mode SwarmSyncClient (authed calls via broker, keyless scan direct — client.ts untouched); logger redacts aph_/sk-ant. New test/broker-fail-safe.test.ts 9 tests incl 4 outage cases HOLD. ap-hub 221/221 (212 unmodified +9), broker 27/27, lint/typecheck/web:build green. src/qbo/write.ts untouched; zero existing tests edited. SPEC §12 aligned to Anthropic-Messages passthrough.
<promise>CHUNK COMPLETE: CHUNK_4_BROKERMODE</promise>

[2026-07-18T05:52:00Z] CHUNK_5_CONNECTOR: provider-neutral seam + canonical AP model — DONE. NEW src/canonical/ (model.ts neutral types: CanonicalBill/Line/Vendor/Account, extensible CanonicalDimension list, Unsupported, ExternalRef w/ neutral `revision`; map.ts stored<->canonical helpers). NEW src/connectors/ (types.ts AccountingConnector+CapabilityMatrix+NotImplementedInPhase; qbo.ts reference adapter WRAPPING src/qbo/write.ts+client.ts delegation-only — createEntity/readEntity/queryEntity/getCompanyInfo delegated, write.ts UNCHANGED; stubs.ts qbd/xero/sage capability-declaring stubs that throw NotImplementedInPhase). NEW test/connector-contract.test.ts: reusable runConnectorContract suite QBO passes (read vendors/accounts, verifyCompanyIdentity match/mismatch, create->readBack confirms externalId+revision), Unsupported dimension surfaced+audited (never dropped), delegation asserted, 3 stubs refuse read/create. Migration 006_provider_neutral: blue-green rename postings->postings_ap (qbo_type->entity_type, qbo_id->external_id, sync_token->revision), updatable back-compat VIEW `postings` (old names, keeps read.test.ts + all source SELECTs working UNMODIFIED), spec VIEW v_postings_qbo, NEW connections table (connection_class cloud|local_desktop CHECK). UP->DOWN->UP verified clean on scratch db. Provider enum widened gmail|qbo|xero|sage_intacct|qbd (enum only). NEW scripts/lint-noleak.mjs + `npm run lint:noleak` GREEN (canonical strict=no provider tokens incl qbo; core=no non-QBO provider tokens; core=no OS tokens outside src/host). ap-hub 230/230 (221 unmodified +9 contract), broker 27/27, lint/typecheck/web:build/lint:noleak green. src/qbo/write.ts logic UNCHANGED.
  DEVIATIONS (honest): (a) blue-green swap makes base table `postings_ap` + updatable view `postings`; required minimal edits to src/pipeline/posting.ts (recordPosting upsert -> postings_ap; ON CONFLICT unsupported on views) and to the shared fixture test/helpers.ts (TRUNCATE target postings->postings_ap + added connections) — NO test ASSERTION changed; read.test.ts & posting.test.ts assertions unmodified & green. (b) lint:noleak grandfathers QBO terms in the pre-existing QBO reference impl (src/qbo/**) and legacy core; it strictly bans ALL provider tokens in src/canonical/** and non-QBO provider + OS tokens in core. A literal repo-wide `qbo` ban is not achievable without a full core rewrite (out of scope for an extraction).
<promise>CHUNK COMPLETE: CHUNK_5_CONNECTOR</promise>
