# How the AP-Hub Engine Works — Plain English, Start to Finish

*Written so anyone can follow it. No jargon without an explanation.*

---

## 1. What this thing is, in one breath

AP-Hub is a robot bookkeeper's assistant. It watches an accounting email inbox, reads
the invoices and bills that arrive there, double-checks them, and turns them into
ready-to-review entries in QuickBooks — so a human accountant approves finished work
instead of typing everything by hand.

Right now it is a **careful pilot**, not the finished product. That means it is wired
up end-to-end but with the training wheels bolted on:

- It **reads** email but **never changes, deletes, or sends** your email (with one tiny
  exception explained later).
- It only writes into a QuickBooks **sandbox** — a fake "practice" company — **never**
  your real books.
- It is being test-driven on a few machines first to prove it's reliable and safe
  before anyone trusts it with real money.

---

## 2. The cast of characters

Think of it as a small team, each with one job:

| Piece | Plain-English role |
|---|---|
| **The Inbox (Gmail)** | Where invoices and bills land. The engine only ever *looks* here. |
| **The Engine (the pilot app)** | The worker that reads, checks, and prepares the bookkeeping. Runs on a Windows PC. |
| **Claude (the AI reader)** | The "eyes." It reads a PDF or photo of an invoice and pulls out the vendor, amount, date, line items. |
| **SwarmSync (the proof service)** | The "fraud & math checker." It independently verifies an invoice is legit and the numbers add up, and stamps a tamper-proof receipt. |
| **QuickBooks (sandbox)** | The accounting books. In the pilot, a *practice* company only. |
| **The Key Broker** | A small always-on internet service (lives on Render) that acts as the team's trusted receptionist and security guard. It hands out access, keeps score, and collects health check-ins. Explained in Section 6. |
| **The Human (you / the accountant)** | Sets things up once, then reviews and approves the finished entries. |

---

## 3. The one-time setup — **this part needs a human**

You do this once per machine, and it takes a few minutes. Nothing accounting-related
happens until you finish it.

1. **Install the engine.** You run one installer file (`install-pilot.ps1`). It does the
   heavy lifting by itself: it drops a private copy of the database and the runtime onto
   your PC, tucked away in your own user folder, on a private "channel" (technical: port
   55432) so it can't bump into anything else on the machine. **You do not need
   administrator rights** — it installs like a normal app, no scary "allow this app to
   make changes" pop-up.
2. **Agree to the telemetry notice.** The installer shows you, in writing, the *only*
   things it will ever phone home about: "I'm alive," "I restarted," "the database is
   healthy," and your time zone. It collects **none** of your invoices, vendors,
   amounts, or emails. You type `I AGREE` to continue.
3. **Connect your Gmail.** A browser page opens; you log into Google and grant read
   access to the accounting inbox. This is the normal Google permission screen — no
   trickery. The engine gets permission to *read* mail, nothing more.
4. **Connect QuickBooks (the practice company).** Same idea: you log into Intuit and
   connect the QuickBooks **sandbox**. The engine physically cannot connect to a real
   company in this pilot — it refuses to start if pointed at production.
5. **Choose how much autonomy to give it.** It starts locked to "off" (it will prepare
   entries but post nothing until you say so). You move it to "assisted" or "auto" when
   you're comfortable.

That's the whole human setup. **From here on, the everyday work runs by itself.**

---

## 4. The everyday loop — **this part runs autonomously**

Once set up, the engine repeats this cycle on its own, around the clock. Here is exactly
what happens to a single bill, step by step. (The technical name for each step is in
parentheses; you can ignore them.)

1. **It checks the inbox.** (*poll*) Every few minutes the engine looks for new
   accounting email. It never marks anything read, never moves or deletes anything.

2. **It screens each new email at the gate.** (*gatekeep*) Before doing anything else,
   the engine decides: does this look like a real bill worth processing? If the setup
   calls for it, a copy of the email can be *forwarded* to one single, pre-locked
   address (this is the one email action the system can take — and it can **only** send
   to that one hard-wired address, nowhere else). A short heads-up can also ping a
   Telegram chat. If the proof service is unreachable at this moment, the email is
   **held**, not waved through — safety first.

3. **It figures out what kind of document it is.** (*classify*) Invoice? Receipt?
   Statement? Not-a-bill? Junk is dropped here.

4. **It reads the document.** (*extract*) Claude, the AI reader, looks at the PDF or
   image and pulls out the details: vendor name, invoice number, date, total, and each
   line item. It also gives a **confidence score** — how sure it is — and does a
   "foot check" (does the line items add up to the total?).

5. **It matches things to your books.** (*map*) It links "the vendor on the invoice" to
   "the matching vendor in QuickBooks," and each line to the right expense account. If
   it has seen this vendor before, it remembers the previous choice.

6. **It builds a draft entry.** (*propose*) Now it assembles a proposed QuickBooks
   transaction — but this draft is **not allowed to move forward** until it has passed
   independent proof.

7. **The proof gate — the heart of the safety design.** Before anything is considered
   "ready," SwarmSync must have independently:
   - scanned the invoice for fraud/tampering (**InvoiceProof**), and
   - verified the extracted numbers (**Verify-API**).

   If either proof is missing, or the proof service is down, the draft is **held for a
   human** — it is *never* quietly approved. "Nothing unscanned gets through" is a hard
   rule.

8. **It posts to the practice books — carefully.** (*post_sandbox*) Only a draft that is
   fully proofed, under your amount ceiling, above the confidence threshold, and free of
   red flags gets posted to the QuickBooks **sandbox**. And even then it is paranoid
   about duplicates:
   - It checks its own records first (has this exact bill been posted already?).
   - It asks QuickBooks whether a matching entry already exists.
   - After creating the entry, it **reads it back** from QuickBooks to confirm it landed
     correctly. If the read-back doesn't match, it flags it instead of trusting it.
   - Every entry gets a unique "fingerprint" so the same bill can never be posted twice,
     even if the network hiccups mid-post.

9. **It stamps a permanent receipt.** (*audit_anchor*) A tamper-proof proof (**AuditProof**)
   is recorded so there's an independent trail that this entry was created and verified.
   If this stamping step ever fails, it **never** re-creates the transaction — it just
   retries the stamp.

10. **You review.** The finished entries show up on a review dashboard. A human with the
    right role approves (or rejects) them. Anything the engine wasn't sure about is
    waiting there with the reason it paused.

**In short:** the engine does the reading, checking, matching, drafting, proofing, and
careful posting on its own. The human does the setup once and the approving at the end.

---

## 5. The safety rails, in plain words

These are promises the system is built to keep no matter what:

1. **Your real email is never touched.** Read-only, always.
2. **The only email it can send is that one locked forward** — to one address that is
   wired in, with no way to change the recipient at runtime.
3. **It only writes to the practice (sandbox) company.** It flat-out refuses to start if
   aimed at real books.
4. **No double-posting, ever.** Two independent duplicate checks plus a fingerprint.
5. **Nothing gets through unchecked.** If the proof service is down, work is **held**,
   not approved. It fails "closed" (safe), never "open" (risky).
6. **No customer's private details in code.** Everything specific to a business is
   configuration, not hard-coded — so the same engine works for anyone.

---

## 6. The plumbing that makes it a real product — the Key Broker

Here's a problem: the AI reader and the proof service normally need secret keys, and you
**don't** want those secret keys copied onto every tester's laptop. So there's a
**Key Broker** — a small always-on service on the internet (running now at
`https://aphub-broker.onrender.com`).

Think of it as a **trusted receptionist with a locked key cabinet**:

- Each pilot machine gets its **own personal pass** (a per-install token). No machine
  ever holds the master keys.
- Every request the engine makes goes *through* the broker. The broker checks the pass,
  keeps a spending limit so no machine can run up a huge bill, and limits how often
  requests can come in.
- If anything upstream fails, the broker **refuses** rather than faking a success — the
  same "fail safe, not sorry" rule.
- A pass can be **revoked instantly** (a kill switch), and losing one pass only affects
  that one machine.

*(Note: in this particular deployment the operator runs the AI as a command-line tool
rather than through paid keys, so the broker is currently running "keyless" — the key
cabinet is there and locked, just empty for now. Everything else about it — passes,
limits, health check-ins — works exactly as described. One consequence worth knowing:
while keyless, a real invoice that reaches the proof gate will correctly **hold**
there rather than post — proof of the fail-safe design, not a full end-to-end post.
Provisioning real proof-service keys in the broker is what unlocks a complete
post-to-sandbox demo.)*

### The health check-ins (telemetry)

Every minute or so, each pilot machine sends the broker a tiny **heartbeat**: "I'm
alive," "I had to restart something," or "my database is healthy." **That's all** — no
business data, ever (there's even an automated test that proves a vendor name or amount
can't sneak into a heartbeat). After the pilot runs for a while, an operator runs one
command (`pilot-report`) and gets **three numbers** that decide whether this design is
trustworthy enough to build into a full product:

1. **What % of working hours was the engine actually up and running?**
2. **When something crashed, did it recover on its own?**
3. **Did the local database ever corrupt?**

### The watchdog (self-healing)

The engine runs as **three cooperating programs**: the private database, the worker (the
brain), and the local web page you review things on. A **supervisor** babysits all three
— if one dies, it restarts it within about a minute and reports the restart. And a
**watchdog** (a scheduled task built into Windows) makes sure the supervisor itself comes
back if it's ever killed or the machine reboots. So the whole thing is designed to pick
itself back up without anyone noticing.

---

## 7. Who does what — the quick reference

| Task | Who | When |
|---|---|---|
| Install the engine on a PC | **Human** (run one file) | Once |
| Approve the telemetry notice (`I AGREE`) | **Human** | Once, during install |
| Connect Gmail (read-only) | **Human** (Google login) | Once |
| Connect QuickBooks sandbox | **Human** (Intuit login) | Once |
| Set the autonomy level (off → assisted → auto) | **Human** | Once, then whenever you like |
| Watch the inbox for new bills | **Engine** | Continuously |
| Screen, read, and extract invoice details | **Engine** | Every new bill |
| Match vendors & accounts to your books | **Engine** | Every new bill |
| Get independent fraud + math proof | **Engine ↔ SwarmSync** | Every new bill |
| Post proofed entries to the sandbox | **Engine** | When safe (proofed, under limits) |
| Hold anything unsure or unproven | **Engine** | Automatically |
| Read back & fingerprint to prevent duplicates | **Engine** | Every post |
| **Review and approve finished entries** | **Human** | Ongoing |
| Keep the 3 programs alive / self-heal | **Supervisor + Watchdog** | Continuously |
| Send health heartbeats to the broker | **Engine** | Every ~minute |
| Hand out passes, enforce limits, guard keys | **Key Broker** | Continuously |
| Pull the 3 reliability numbers | **Operator** (`pilot-report`) | After ~48 hours+ |

**Rule of thumb:** the human sets it up and signs off on the results; **everything in the
middle runs by itself.**

---

## 8. What's real today vs. what's still to come (honest status)

**Working and proven live right now:**

- The Key Broker is deployed and live on the internet, hands out passes, refuses bad
  ones, and collects heartbeats. Verified with real checks (health OK, valid pass
  accepted, revoked pass rejected).
- The engine installs on a Windows PC, runs its three programs, self-heals when a
  program is killed, keeps its database on a private channel that doesn't collide with
  anything else, and phones home health heartbeats to the live broker.
- **No secret keys are stored on the pilot machine** — verified by scanning the disk.
- The full read → check → proof → sandbox-post pipeline is built and tested.

**Deliberately limited in this pilot (by design):**

- Writes go to a QuickBooks **sandbox** only. Real books are off-limits.
- Gmail is **read-only**. The only outbound email is the one locked forward.
- **QuickBooks Online sandbox is the only accounting write path.** QuickBooks
  Desktop offers read-only verification. Xero and Sage are capability-declaring
  placeholders that intentionally refuse runtime operations.

**Not yet proven (the honest to-do before wider rollout):**

- Installing under a *standard* (non-administrator) Windows user, on a *clean* machine,
  and confirming everything comes back to life *after a full reboot* — these still need
  to be demonstrated on a real tester's PC before handing it out as a "just run the
  installer" experience.

---

*Bottom line: today the engine is a supervised, self-healing pilot that safely turns
inbox invoices into reviewable practice-company bookkeeping, with a live internet service
guarding the keys and tracking its reliability — and a human only needed at the two ends:
setup and final approval.*
