AP-hub North Star UX Specification
Version: 1.0  
Product: AP-hub  
Purpose: Highest-level product philosophy, workflow doctrine, and UX acceptance standard for AP-hub.  
Core idea: AP-hub should become the simplest, most trusted, least-friction AI accounting hub for Gmail-driven financial operations and QuickBooks Online Advanced automation.
---
0. North Star Summary
AP-hub is not just another bookkeeping dashboard, AP automation tool, inbox assistant, or QuickBooks connector.
AP-hub is the financial operating layer between a business's messy real-world communication and its clean accounting system.
It should connect to Gmail, read financial messages, understand invoices and accounting documents, download attachments, extract the required facts, map them correctly, post them to QuickBooks Online Advanced, track every step, surface only exceptions, and help reconcile the books without making the customer think like an accountant.
The product should feel like:
Stripe for onboarding: fast, guided, trustworthy, and almost impossible to get lost.
Linear for workflow: clear status, fast triage, clean ownership, no clutter.
Notion for organization: everything has a place, but the user does not have to manually organize it.
Apple for simplicity: complex machinery hidden behind obvious actions.
Superhuman for speed: inbox-driven workflows feel instant and keyboard-fast.
Cursor for AI assistance: AI is present where it helps, but never feels like a gimmick.
Figma for polish: precise, consistent, collaborative, and confidence-building.
The customer should feel as though AP-hub already understands their business.
They should spend almost no time learning the product.
Instead, AP-hub should learn them.
---
1. Product Philosophy
1.1 The Core Promise
AP-hub turns financial emails and documents into verified accounting actions.
The customer should be able to say:
> "Connect my Gmail and QuickBooks, and keep my accounting flow clean unless something actually needs me."
AP-hub should then handle the hidden work:
Watch relevant Gmail inboxes, labels, and threads.
Identify invoices, bills, receipts, statements, W-9s, payment confirmations, customer payments, and reconciliation evidence.
Download, store, hash, and link attachments.
Extract structured data from PDFs, images, CSVs, and email bodies.
Match vendors, customers, classes, locations, projects, products, services, accounts, and payment methods.
Prepare or post transactions to QuickBooks Online Advanced.
Attach source documents to accounting records.
Track status from receipt to posting to reconciliation.
Draft or send safe replies.
Escalate only exceptions, risks, and decisions.
1.2 Complexity Belongs Inside AP-hub
Complexity belongs inside AP-hub, not inside the customer's head.
The customer should never need to understand:
Gmail API scopes.
QuickBooks API objects.
OAuth refresh tokens.
OCR.
AI extraction.
Prompt chains.
Embeddings.
Queue workers.
Idempotency keys.
Vendor matching algorithms.
Reconciliation heuristics.
Accounting terminology.
Accrual versus cash handling unless the business actually needs to decide.
Which document belongs to which transaction.
Which QBO endpoint is being used.
The customer should see only:
What AP-hub found.
What AP-hub did.
What still needs attention.
Why it matters.
What evidence supports it.
What action, if any, is needed.
1.3 The Product Is Not a Checklist
Most accounting software makes users work through lists.
AP-hub should make lists disappear.
The user should not see:
> "Upload all vendor invoices, receipts, statements, W-9s, payment confirmations, and reconciliation documents."
They should see:
> "We found 93 invoices, matched 88 to vendors and projects, posted 81 safely, held 7 for review, and found 5 payments without source documents."
Then AP-hub should show the exact exceptions:
"This invoice is missing a project."
"This vendor changed payment instructions."
"This bill appears to be a duplicate."
"This payment cleared the bank but has no source invoice."
"This Gmail thread confirms payment, but QBO has not recorded it."
---
2. Design Principles
2.1 The Lowest-Cognitive-Load Rule
For every workflow, AP-hub should ask:
Can this be automated?
Can this be discovered?
Can this be inferred?
Can this be learned from prior behavior?
Can this be delayed until it truly matters?
Can this be removed?
Can this be one click?
Can this be zero clicks?
If the answer is yes, redesign the workflow.
2.2 The Grandma Test
A business owner who knows nothing about accounting should be able to use AP-hub.
If a workflow would confuse them, the workflow is wrong.
Do not blame the user.
Bad:
> "Map this vendor to an expense account and select the correct class and location."
Better:
> "This looks like a plumbing invoice for the Aspen project. Should future invoices from this vendor use Repairs & Maintenance for Aspen?"
Best:
> "Mapped using your prior rule: Plumbing Co. → Repairs & Maintenance → Aspen. Posted and attached source invoice."
2.3 Exception-Driven, Not Dashboard-Driven
AP-hub should not become a wall of dashboards.
The default experience should be:
Everything is running.
Most items are complete.
Here are the few things that actually need you.
Dashboards are allowed only when they reduce confusion or increase trust.
2.4 Deterministic First, AI Second
AI should not guess when rules can decide.
Use this hierarchy:
Exact deterministic match.
Prior approved mapping rule.
QBO object match.
Business-specific rule.
Document evidence.
Confidence-scored AI inference.
Human exception review.
AI should make the product feel intelligent, not random.
2.5 Evidence Over Magic
Every important decision must answer:
> "What evidence caused this?"
AP-hub should show:
Source email.
Attachment.
Document page.
Extracted text or visual region.
Related QBO record.
Prior approved rule.
Calculation.
Confidence score.
Plain-English reasoning summary.
Never require blind trust.
2.6 Human Attention Is Sacred
Every interruption must justify itself.
Every approval must justify itself.
Every notification must justify itself.
Every question must justify itself.
AP-hub should protect the user's attention as if it were company cash.
2.7 Install Once, Remember Forever
The user should not repeatedly configure the same business logic.
If AP-hub learns:
Which project a vendor belongs to.
Which QBO account to use.
Which Gmail label contains invoices.
Which approval threshold applies.
Which fields are required for a vendor.
Which customer payment emails signal AR activity.
It should remember and apply that knowledge until changed.
---
3. Customer Personas
3.1 The Business Owner
Mindset: "I want the books handled. I do not want to become an accountant."  
Needs: Confidence, fewer questions, fewer surprises, simple explanations.  
Fear: Something gets posted wrong, paid twice, missed, or filed incorrectly.  
AP-hub promise: "We found it, matched it, posted it, and here is the proof."
3.2 The Controller / Accounting Manager
Mindset: "I need clean workflows, clean audit trails, fewer manual steps, and no hidden mess."  
Needs: Visibility, controls, exception queue, mapping accuracy, QBO reliability.  
Fear: Black-box automation creates cleanup work.  
AP-hub promise: "Routine work is automated, risky work is held, and every action is traceable."
3.3 The Bookkeeper
Mindset: "I need to process a lot of documents quickly and avoid rework."  
Needs: Fast review, duplicate checks, consistent mapping, easy corrections.  
Fear: AI creates more exceptions than it solves.  
AP-hub promise: "Fix once, learn forever."
3.4 The CPA / Tax Preparer
Mindset: "I need source support, clean books, and confidence in what happened."  
Needs: Evidence, audit trail, reconciliations, tax-ready categorization.  
Fear: Missing documents and unsupported transactions.  
AP-hub promise: "Every transaction has source evidence or a visible gap."
3.5 The Implementer / AI Coder
Mindset: "I need simple primitives that survive real-world edge cases."  
Needs: Clear states, APIs, schemas, testable workflows, idempotency, dry-run mode.  
Fear: Overbuilt architecture that cannot be installed or debugged.  
AP-hub promise: "One pipeline, one status model, one exception model, one audit trail."
---
4. First-Run Experience
4.1 Ideal Onboarding
Design onboarding as if every extra click costs money.
The ideal onboarding should be:
Create account.
Connect Gmail or Google Workspace.
Connect QuickBooks Online Advanced.
Select company.
Select accounting mode and date range.
Choose automation level.
Run dry-run scan.
Review sample findings.
Approve initial mapping rules.
Turn on automation by confidence threshold.
Everything else should happen automatically.
4.2 Onboarding Must Discover Before Asking
AP-hub should attempt to discover information before asking the customer.
Order of operations:
Retrieve from QBO.
Read Gmail metadata and selected accounting labels.
Search email attachments.
Search connected document storage.
Infer from historical vendor/customer behavior.
Infer from prior mappings.
Ask another connected user if permissions allow.
Ask the customer only when necessary.
4.3 First-Run Output
The first meaningful output should not be a blank dashboard.
It should be a business-specific summary:
> "AP-hub found 312 accounting-related emails from the last 90 days.  
> 184 had attachments.  
> 143 appear to be vendor invoices.  
> 96 vendors matched your QBO vendor list.  
> 41 invoices can be prepared with high confidence.  
> 9 need your review before posting."
Then show:
Safe automations ready to turn on.
Mapping rules learned.
Exceptions requiring setup.
Risks detected.
Recommended next step.
4.4 First-Run Must Be Dry-Run by Default
Never surprise-post to QBO during first setup.
Default first-run mode:
Read Gmail.
Download attachments.
Extract data.
Match QBO objects.
Prepare proposed transactions.
Show confidence.
Show evidence.
Do not post until explicitly enabled.
---
5. Daily Workflow
5.1 The Default Daily Experience
The ideal daily experience is no experience.
If AP-hub can process routine work safely, the user should not have to open the product.
When they do open it, they should see:
What was processed.
What was posted.
What was reconciled.
What needs attention.
What risks were blocked.
5.2 Daily Summary Format
Daily summaries should be plain English:
> "Yesterday AP-hub processed 23 financial emails.  
> 14 vendor invoices were posted to QBO.  
> 6 receipts were matched to card transactions.  
> 2 bills are waiting on project confirmation.  
> 1 vendor bank-change warning is held for review."
5.3 Daily User Actions
The user should only have to do things like:
Approve a new mapping rule.
Confirm a project/customer/location.
Resolve a duplicate.
Reject a suspicious bank change.
Approve a low-confidence transaction.
Ask AP-hub why it made a decision.
5.4 Keyboard-Fast Review
For accounting staff, AP-hub should support fast triage:
Approve.
Reject.
Edit mapping.
Mark duplicate.
Ask vendor for missing info.
Open source evidence.
Open QBO record.
A reviewer should be able to clear routine exceptions without unnecessary page changes.
---
6. Month-End, Year-End, and Tax-Season Workflow
6.1 The Tax-Ready Accounting Philosophy
AP-hub should not wait until tax season to organize evidence.
Every posted transaction should be moving toward:
Source-supported books.
Vendor/customer clarity.
Project/class/location accuracy.
Reconciliation status.
Tax-ready categorization.
Exception visibility.
6.2 Month-End Workflow
At month-end, AP-hub should show:
Bills received but not posted.
Payments without source documents.
Vendor statements with unmatched invoices.
Bank transactions without receipts.
Customer payments not matched to invoices/deposits.
Possible duplicates.
Class/location/project gaps.
Reconciliation exceptions.
The user should not receive a generic close checklist. They should receive an evidence-based close gap report.
6.3 Year-End Workflow
At year-end, AP-hub should show:
Vendors missing W-9s.
1099-related payments requiring review.
Large uncategorized or unusual transactions.
Owner-related transactions.
Intercompany transactions.
Fixed-asset candidates.
Loan documents or interest statements missing.
Unreconciled bank and credit card accounts.
Material transactions lacking source documents.
6.4 Tax-Season Workflow
For tax support, AP-hub should provide:
Clean source document packages.
Transaction support by category.
Vendor and 1099 support.
Reconciliation status.
Open questions with exact evidence gaps.
Exportable accountant review package.
The tax workflow should say:
> "We have source support for 97% of material transactions. These 12 items still need attention."
Not:
> "Please upload all tax documents."
---
7. Exception-Handling Philosophy
7.1 Exceptions Are the Product
The main product experience is not posting transactions. The main product experience is knowing what did not safely post and why.
AP-hub should treat exceptions as first-class objects.
Each exception must include:
Plain-English issue.
Business impact.
Source evidence.
Recommended fix.
One-click action if possible.
Future learning option.
7.2 Exception Categories
Core exception types:
Low-confidence extraction.
Unknown vendor.
Unknown customer.
Unknown project/class/location.
Missing invoice number.
Missing due date.
Invoice total mismatch.
Possible duplicate invoice.
Vendor bank-change warning.
Unsupported file type.
Corrupted attachment.
No attachment found.
Email-only invoice with incomplete details.
QBO API failure.
OAuth authorization failure.
Reconciliation mismatch.
Payment without source document.
Source document without QBO transaction.
Approval threshold exceeded.
7.3 Fix Once, Learn Forever
Every exception fix should ask:
> "Should AP-hub handle this the same way next time?"
Examples:
Always map this vendor to this QBO vendor.
Always code this vendor to this account.
Always assign this vendor to this project.
Always hold invoices over this amount.
Always ask this vendor for missing invoice numbers.
Never auto-post bank-change emails.
---
8. AI Interaction Philosophy
8.1 AI Is a Coworker, Not a Mascot
AI should appear when it helps the user accomplish a real accounting task.
Good AI interactions:
"Why was this held?"
"What evidence supports this mapping?"
"Find invoices from this vendor last quarter."
"Draft a reply asking for a W-9."
"Explain why this looks like a duplicate."
"Show me unreconciled payments over $5,000."
"Create a rule for future invoices like this."
Bad AI interactions:
Generic chatbot floating over everything.
Unclear suggestions.
Unverifiable guesses.
Fancy language that hides uncertainty.
8.2 AI Must Show Its Work
For every AI-assisted decision, AP-hub must show:
Input source.
Extracted fields.
Matching logic.
Confidence.
Prior rule used, if any.
Reasoning summary.
Human override path.
8.3 AI Should Not Override Controls
AI may recommend.
AI may prepare.
AI may classify.
AI may draft.
AI may auto-post only inside explicit, approved confidence and control boundaries.
AI should never:
Change vendor bank information automatically.
Send sensitive information without permission.
Override approval thresholds.
Hide uncertainty.
Delete source documents.
Reconcile ambiguous payments without evidence.
Create permanent mapping rules without review unless explicitly allowed.
---
9. Integration Philosophy
9.1 Connect Once, Remember Forever
AP-hub should connect once and keep working.
Priority integrations:
QuickBooks Online Advanced.
Gmail / Google Workspace.
Google Drive.
Outlook / Microsoft 365.
Xero, later if the product expands beyond QBO-first businesses.
9.2 QBO Is the Accounting System of Record
AP-hub should not replace QBO.
AP-hub should be the automation, evidence, mapping, review, and reconciliation layer around QBO.
QBO should remain the official ledger for:
Vendors.
Customers.
Bills.
Expenses.
Invoices.
Payments.
Deposits.
Classes.
Locations.
Projects.
Products/services.
Accounts.
Attachments.
AP-hub should track:
Source emails.
Source documents.
Extraction state.
Mapping state.
Posting state.
Reconciliation state.
Exceptions.
Audit logs.
Learned rules.
9.3 Gmail Is the Operational Front Door
Many businesses already run AP/AR through email.
AP-hub should use Gmail as a primary financial document intake layer.
It should understand:
Accounting labels.
Vendor threads.
Customer threads.
Attachments.
Payment confirmations.
W-9 requests.
Statement emails.
Follow-up replies.
Missing-document conversations.
9.4 Integrations Must Be Least-Privilege
Every integration should request the lowest practical access.
Preferred scope pattern:
Read relevant Gmail metadata and messages.
Download attachments only from authorized labels/mailboxes.
Draft replies before sending by default.
Allow sending only when explicitly enabled.
Access QBO company data necessary for accounting automation.
Write to QBO only after dry-run and approval thresholds are configured.
---
10. Document-Discovery Philosophy
10.1 Search Before Asking
Before AP-hub asks a user for a document, it should search:
Gmail attachments.
Gmail thread bodies.
Google Drive / shared folders.
QBO attachments.
Prior processed documents.
Vendor/customer patterns.
Related payment confirmations.
Related statements.
10.2 Documents Need Durable Identity
Every document must have:
File hash.
Source email/message ID.
Thread ID.
Attachment ID.
Original filename.
Normalized filename.
Received date.
Sender.
Document type.
Extracted fields.
Related QBO object.
Processing status.
Duplicate status.
Retention location.
10.3 The User Should Not Organize Files Manually
AP-hub should create order from chaos.
If a vendor sends:
Invoice PDF.
Statement PDF.
W-9 PDF.
Payment instructions.
A corrected invoice later.
AP-hub should group them into the right vendor and transaction context automatically.
---
11. Notification Philosophy
11.1 Notifications Must Be Earned
AP-hub should not notify users about routine success unless requested.
Notify only for:
Material risk.
Required action.
Approval needed.
Failed connection.
Suspicious vendor payment change.
Reconciliation issue.
Automation paused.
Month-end/year-end close gap.
11.2 Notification Copy Must Be Specific
Bad:
> "You have 9 exceptions."
Good:
> "9 invoices need review: 4 missing projects, 3 possible duplicates, 1 vendor bank-change warning, and 1 unreadable PDF."
11.3 Digest by Default
Default notification pattern:
Daily digest for normal operations.
Immediate alert for risk.
Weekly summary for leadership.
Month-end close gap summary.
---
12. Search Philosophy
12.1 Search Should Understand Accounting Intent
Search should support questions like:
"Show unpaid invoices from Plumbing Co."
"Find all receipts for the Aspen project in May."
"Which vendor invoices are missing W-9s?"
"Show payments posted to QBO without source docs."
"Find bank-change emails."
"Show duplicate invoice warnings."
"What is unreconciled over $1,000?"
12.2 Search Results Must Be Evidence-Rich
Each result should show:
Vendor/customer.
Amount.
Date.
Source email.
Attachment.
QBO link.
Status.
Exception, if any.
Confidence/evidence.
---
13. Approval Philosophy
13.1 Approval by Exception
Routine work should not require human approval forever.
Use approval thresholds:
Auto-post high-confidence, low-risk items.
Hold unknown mappings.
Hold high-dollar transactions.
Hold new vendors.
Hold bank/payment instruction changes.
Hold low-confidence extraction.
Hold duplicates.
Hold anything that violates policy.
13.2 Approval Should Teach the System
Approvals should create reusable rules.
Examples:
Approve once for this transaction only.
Approve and remember this vendor mapping.
Approve and remember this project rule.
Approve and remember this account category.
Reject and mark as duplicate.
Reject and ask vendor for corrected invoice.
---
14. Mobile Philosophy
AP-hub mobile should not attempt to recreate the full desktop accounting system.
Mobile should focus on:
Approving exceptions.
Reviewing evidence.
Confirming project/customer/vendor context.
Rejecting suspicious changes.
Capturing receipts.
Reading daily summaries.
Asking AP-hub simple questions.
Mobile actions should be short, obvious, and safe.
---
15. Accessibility Philosophy
AP-hub should be usable by people under stress, in a hurry, and with varying levels of accounting literacy.
Accessibility standards:
Plain-English labels.
Strong contrast.
Keyboard navigation.
Screen-reader-friendly status language.
No color-only status indicators.
Clear focus states.
Descriptive buttons.
Avoid dense tables unless review work requires them.
Explain acronyms.
Provide non-accountant translations.
---
16. Trust and Transparency Standards
Every trust-critical screen must show:
What AP-hub found.
What AP-hub verified.
What AP-hub posted.
What AP-hub held.
What still needs attention.
Why an item matters.
Evidence source.
Confidence level.
User override path.
Trust-killing patterns:
"AI says so."
No source document link.
No QBO link.
No audit trail.
No way to reverse or correct.
Vague confidence statements.
Silent failures.
Silent auto-posting.
---
17. Error-State Standards
Errors must be actionable.
Bad:
> "QBO sync failed."
Good:
> "QBO rejected this bill because the vendor is inactive. Reactivate the vendor in QBO or choose a different vendor."
Every error state should include:
What happened.
Why it likely happened.
Whether data was changed.
How to fix it.
Whether retry is safe.
Whether AP-hub will retry automatically.
Link to source item.
Link to related QBO record, if any.
---
18. Performance Standards
AP-hub should feel immediate even when background work takes time.
Use:
Progressive loading.
Streaming status updates.
Background synchronization.
Incremental processing.
Predictive preloading.
Dry-run previews.
Clear job states.
Never leave the user staring at vague spinners.
Show:
"Scanning Gmail."
"Downloading 14 attachments."
"Matching vendors."
"Preparing 9 QBO bills."
"Holding 2 for review."
---
19. Information Architecture
19.1 Primary Navigation
AP-hub should organize around work, not modules.
Recommended top-level areas:
Today — what happened and what needs attention.
Inbox — financial emails and documents AP-hub found.
Transactions — prepared, posted, failed, reconciled, or held records.
Exceptions — the action queue.
Mappings — vendors, customers, accounts, classes, locations, projects, rules.
Reconciliation — source docs, bank/QBO matches, missing evidence.
Reports — operational and accounting automation performance.
Settings — integrations, permissions, thresholds, business rules.
Audit Trail — all decisions, evidence, and system actions.
19.2 Status Model
Every item should fit into one status model:
Received.
Classified.
Attachment saved.
Extracted.
Mapped.
Ready to post.
Posted.
Synced.
Reconciled.
Exception.
Duplicate.
Rejected.
Archived.
19.3 Core Objects
AP-hub should be built around these objects:
Email message.
Thread.
Attachment/document.
Extracted document data.
Vendor/customer candidate.
Mapping rule.
Proposed QBO transaction.
Posted QBO transaction.
Exception.
Reconciliation match.
Audit event.
User decision.
---
20. UX Heuristics
Every feature should be reviewed against these questions:
Does this reduce cognitive load?
Does this reduce clicks?
Does this reduce setup work?
Does this protect trust?
Does this show evidence?
Does this make the user more confident?
Does this avoid accounting jargon?
Does this remember what the user already taught it?
Does this prevent duplicate work?
Does this fail safely?
Does this preserve an audit trail?
Does this make QBO cleaner?
Does this reduce future exceptions?
Does this support dry-run before automation?
Does this make the simplest path the default path?
---
21. UX Anti-Patterns
Do not build these unless there is no simpler option:
Giant configuration screens.
Generic dashboards with no action path.
AI chat that cannot act or show evidence.
Manual upload-first workflows.
Asking users to classify documents AP-hub could classify.
Asking users to map vendors repeatedly.
Posting to QBO without traceable evidence.
Automation with no dry-run.
Success messages that hide partial failure.
Technical errors with no recovery path.
Over-flexible settings that require accounting expertise.
Every-feature-on-the-left-rail navigation.
Notifications for routine success.
Separate workflows for every document type if one pipeline can handle them.
Forcing users to understand internal architecture.
---
22. UX Success Metrics
22.1 Onboarding Metrics
Time to connect Gmail.
Time to connect QBO.
Time to first dry-run result.
Time to first approved mapping.
Time to first safe auto-post.
Number of required setup decisions.
Number of support touches during install.
22.2 Automation Metrics
Percent of financial emails correctly classified.
Percent of attachments successfully extracted.
Percent of documents matched to QBO entities.
Percent of safe transactions auto-posted.
Duplicate prevention rate.
Exception rate by type.
Human touches per transaction.
Average time from email receipt to QBO posting.
Average time from posting to reconciliation status.
22.3 Trust Metrics
Percent of posted transactions with source document attached.
Percent of material transactions with evidence.
User override rate.
Mapping correction rate.
False positive duplicate rate.
False negative duplicate rate.
QBO posting error rate.
Reversal/correction rate.
22.4 Business Outcome Metrics
Hours saved per month.
Close cycle time reduction.
Missing document reduction.
AP processing cost reduction.
Reconciliation exception reduction.
Vendor response time improvement.
Audit/tax support package completeness.
---
23. UX Review Checklist
Before any feature ships, answer yes to these:
The user can understand the workflow without accounting training.
The feature has a dry-run path if it can modify accounting records.
The feature shows source evidence for important decisions.
The feature has a safe failure state.
The feature avoids duplicate processing.
The feature writes to the audit trail.
The feature reduces future work.
The feature does not require unnecessary configuration.
The feature supports exception-driven review.
The feature can be explained in one sentence.
The feature respects least-privilege integration access.
The feature does not make the customer manage internal AI or infrastructure.
If any answer is no, redesign before shipping.
---
24. Feature Acceptance Criteria
A feature is acceptable only if it meets the following standards:
24.1 Gmail Feature Acceptance
Uses least-privilege scopes where practical.
Tracks message ID and thread ID.
Avoids duplicate processing.
Preserves source email link.
Handles multiple attachments.
Handles body-only invoices.
Supports draft-before-send by default.
Logs every read, download, draft, and send action.
24.2 Document Feature Acceptance
Stores original file.
Stores hash.
Stores normalized metadata.
Links document to source email.
Links document to QBO record when posted.
Handles extraction failure safely.
Shows extracted fields and evidence.
Supports duplicate detection.
24.3 QBO Feature Acceptance
Uses QBO API, not browser automation, unless absolutely necessary.
Supports dry-run.
Uses idempotency or equivalent duplicate protection.
Validates vendor/customer/account/class/location/project mappings before posting.
Attaches source documents where possible.
Logs QBO request/response outcome without exposing secrets.
Handles API failure with safe retry or review.
Provides link to posted QBO object.
24.4 Mapping Feature Acceptance
Shows why a mapping was selected.
Uses prior approved rules before AI inference.
Allows correction.
Allows "apply once" or "remember for next time."
Tracks confidence.
Prevents silent remapping of high-risk fields.
24.5 Reconciliation Feature Acceptance
Shows source document, QBO record, and payment/bank evidence where available.
Distinguishes exact matches from probable matches.
Does not mark ambiguous matches as fully reconciled without review.
Flags missing source documents.
Flags payments without invoices.
Flags invoices without payments when expected.
24.6 AI Feature Acceptance
States confidence.
Shows evidence.
Allows override.
Does not hide uncertainty.
Does not perform high-risk actions without approval.
Improves future behavior through approved corrections.
---
One-Page North Star Manifesto
AP-hub Manifesto
AP-hub exists to make business accounting feel effortless, trustworthy, and automatic.
The product's job is not to make users better at accounting.
The product's job is to make accounting complexity disappear.
AP-hub should connect to the systems businesses already use, especially Gmail and QuickBooks Online Advanced, and quietly turn messy financial communication into clean, verified accounting action.
The customer should not chase invoices, rename files, classify documents, memorize accounting categories, export reports, or wonder whether something was posted correctly.
AP-hub should find the document, understand it, map it, post it, attach the evidence, track the status, reconcile what it can, and ask for help only when help is truly needed.
Human attention is sacred.
Every question must earn its place.
Every click must earn its place.
Every notification must earn its place.
Every exception must be specific, contextual, and actionable.
AI is not a magic trick. AI is a worker inside a controlled accounting system. It must show evidence, respect thresholds, preserve audit trails, and fail safely.
Automation should be invisible when it works and clear when it cannot.
AP-hub must never become a maze of settings, dashboards, jargon, or technical architecture. The simplest path must be the default path. The safest path must be the obvious path. The evidence-backed path must be the only path.
If a user has to think like an accountant, the UX failed.
If a user has to understand the AI architecture, the UX failed.
If a user has to manually organize documents AP-hub could find, the UX failed.
If a user sees a generic checklist instead of exact missing items, the UX failed.
If a transaction posts without explainable evidence, the trust model failed.
AP-hub should feel calm, fast, precise, and deeply competent.
The customer should feel:
> "It found what I needed, did what was safe, held what was risky, and showed me exactly why."
That is the North Star.