/**
 * QuickBooks Web Connector session state — a pull queue of qbXML work items.
 *
 * The Web Connector polls the SOAP endpoint on its own schedule; it does NOT
 * support synchronous request/response. So the pipeline (or an operator via the
 * CLI) ENQUEUES qbXML requests here, and QBWC drains them one at a time when it
 * next connects, handing each response back. This is deliberately different from
 * the synchronous QBO REST writer — a real-books mutation only happens when the
 * operator has both enabled write mode AND explicitly enqueued a write item.
 */

import { isWriteRequest } from './qbxml.js';

export type WorkStatus = 'pending' | 'sent' | 'done' | 'error';

export interface WorkItem {
  id: string;
  label: string;
  qbxml: string;
  isWrite: boolean;
  status: WorkStatus;
  response?: string;
  error?: string;
}

/** Thrown when a write item is enqueued while the session is read-only. */
export class WriteNotAllowedError extends Error {
  constructor() {
    super(
      'QuickBooks Desktop is in READ-ONLY mode — a write request (Add/Mod/Del/Void) was refused. ' +
        'Set QB_DESKTOP_MODE=write to allow real-books writes.',
    );
    this.name = 'WriteNotAllowedError';
  }
}

export type QbDesktopMode = 'readonly' | 'write';

export class QbwcSession {
  readonly ticket: string;
  readonly mode: QbDesktopMode;
  private items: WorkItem[] = [];
  private cursor = 0;

  constructor(ticket: string, mode: QbDesktopMode) {
    this.ticket = ticket;
    this.mode = mode;
  }

  /**
   * Enqueue a qbXML request. A write request is HARD-REFUSED in read-only mode —
   * the single chokepoint that keeps read-only genuinely read-only.
   */
  enqueue(label: string, qbxml: string): WorkItem {
    const write = isWriteRequest(qbxml);
    if (write && this.mode !== 'write') throw new WriteNotAllowedError();
    const item: WorkItem = {
      id: String(this.items.length + 1),
      label,
      qbxml,
      isWrite: write,
      status: 'pending',
    };
    this.items.push(item);
    return item;
  }

  /** The next pending item (marks it sent), or null when the queue is drained. */
  next(): WorkItem | null {
    while (this.cursor < this.items.length) {
      const item = this.items[this.cursor];
      if (item && item.status === 'pending') {
        item.status = 'sent';
        return item;
      }
      this.cursor++;
    }
    return null;
  }

  /** Record the response for the in-flight (sent) item and advance. */
  record(response: string, isError = false): void {
    const item = this.items[this.cursor];
    if (!item) return;
    item.response = response;
    if (isError) {
      item.status = 'error';
      item.error = response;
    } else {
      item.status = 'done';
    }
    this.cursor++;
  }

  /** Integer 0..100 progress the Web Connector shows in its UI. */
  progress(): number {
    if (this.items.length === 0) return 100;
    const settled = this.items.filter((i) => i.status === 'done' || i.status === 'error').length;
    return Math.min(100, Math.round((settled / this.items.length) * 100));
  }

  get done(): boolean {
    return this.items.every((i) => i.status === 'done' || i.status === 'error');
  }

  all(): readonly WorkItem[] {
    return this.items;
  }
}

/** Process-lifetime registry of sessions keyed by ticket (single-operator pilot). */
const sessions = new Map<string, QbwcSession>();
/** Items enqueued before a Web Connector session exists, drained on authenticate. */
const pending: Array<{ label: string; qbxml: string }> = [];

export function createSession(ticket: string, mode: QbDesktopMode): QbwcSession {
  const s = new QbwcSession(ticket, mode);
  // Adopt anything enqueued before the connector authenticated.
  for (const p of pending.splice(0)) s.enqueue(p.label, p.qbxml);
  sessions.set(ticket, s);
  return s;
}

export function getSession(ticket: string): QbwcSession | undefined {
  return sessions.get(ticket);
}

export function endSession(ticket: string): void {
  sessions.delete(ticket);
}

/**
 * Enqueue work for the NEXT Web Connector connection. If a session is already
 * live it goes straight onto it (respecting its read-only guard); otherwise it
 * waits in `pending` until the connector authenticates. The write guard is
 * re-checked per-session, so pre-queued writes still refuse in a read-only run.
 */
export function enqueueForNextRun(label: string, qbxml: string): void {
  const live = [...sessions.values()].find((s) => !s.done);
  if (live) {
    live.enqueue(label, qbxml);
    return;
  }
  pending.push({ label, qbxml });
}

/** A cross-session snapshot for the CLI `qbdesktop status` command. */
export function snapshotWork(): {
  pendingBeforeConnect: number;
  sessions: Array<{
    ticket: string;
    mode: QbDesktopMode;
    progress: number;
    items: Array<{ id: string; label: string; isWrite: boolean; status: WorkStatus; statusFromResponse?: string }>;
  }>;
} {
  return {
    pendingBeforeConnect: pending.length,
    sessions: [...sessions.values()].map((s) => ({
      ticket: s.ticket,
      mode: s.mode,
      progress: s.progress(),
      items: s.all().map((i) => ({
        id: i.id,
        label: i.label,
        isWrite: i.isWrite,
        status: i.status,
        statusFromResponse: i.response ? i.response.slice(0, 120) : undefined,
      })),
    })),
  };
}

/** Test/inspection helpers. */
export function pendingCount(): number {
  return pending.length;
}
export function resetSessions(): void {
  sessions.clear();
  pending.length = 0;
}
