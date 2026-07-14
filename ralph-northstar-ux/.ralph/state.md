# Ralph State

**Current Iteration:** 4

Current chunk: CHUNK_4_ACTION
Current task: 5 of 5 (all complete)
Last completed: CHUNK_4_ACTION — all 5 tasks; gate GREEN (128/128, was 114/114)
Status: COMPLETE — CHUNK_4_ACTION done. Gate `migrate:up && lint && typecheck && test` exit 0. DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub. Action service layer src/services/action/index.ts (runApprove/runReject/runRetry/runRemap/runLearn/runSendReply) built as the thin auth-guard→parse→service→JSON wrapper (analogous to runRead); ALL logic gate-covered. Thin app/api/** POST wrappers added: proposals/[id]/approve|reject|retry, mappings/remap, corrections/learn, replies/[id]/send. Role gating via requireSession (owner_controller for approve/retry/reply; +bookkeeper for reject/remap/learn). Approve→201 {posting_id,qbo_type,qbo_id,qbo_link,mode:sandbox}; 409 ALREADY_POSTED on dedup; 202 HELD_FOR_REVIEW on fail-safe hold; 202 QBO_RETRY on QBO throw. Reply send-lockdown: any recipient field → 400 VALIDATION; forwarder gets messageId only (no recipient param). Approve reaches QBO only via approveProposal→postOnce→write.ts; send only via forwarder. write.ts/forwarder.ts/pipeline UNTOUCHED. Six-guarantee suite green. Next: CHUNK_5_FRONTEND.

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format — loop scripts update it via sed.
