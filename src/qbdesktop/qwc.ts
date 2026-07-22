/**
 * `.QWC` generator — the config file the operator imports into the QuickBooks
 * Web Connector to register ap-hub as an integrated application.
 *
 * SAFETY: when the session mode is read-only we set <IsReadOnly>true</IsReadOnly>,
 * so the Web Connector itself refuses any write request — a second, independent
 * guard on top of the session's own write refusal (session.ts).
 */

import { randomUUID } from 'node:crypto';
import type { QbDesktopMode } from './session.js';

export interface QwcOptions {
  appName?: string;
  appUrl: string; // e.g. http://localhost:3001/qbwc  (http allowed for localhost)
  appDescription?: string;
  appSupportUrl?: string; // must share the AppURL host
  username: string;
  mode: QbDesktopMode;
  ownerId?: string; // GUID in braces; generated if omitted
  fileId?: string; // GUID in braces; generated if omitted
  runEveryNMinutes?: number; // 0 / omit => manual "Update Selected" only
}

function braced(guid: string): string {
  return guid.startsWith('{') ? guid : `{${guid}}`;
}

export function generateQwc(opts: QwcOptions): string {
  const appName = opts.appName ?? 'ap-hub';
  const appDesc = opts.appDescription ?? 'ap-hub QuickBooks Desktop connector (qbXML via Web Connector).';
  const support = opts.appSupportUrl ?? new URL('/', opts.appUrl).toString();
  const ownerId = braced(opts.ownerId ?? randomUUID());
  const fileId = braced(opts.fileId ?? randomUUID());
  const readOnly = opts.mode === 'readonly';
  const scheduler =
    opts.runEveryNMinutes && opts.runEveryNMinutes > 0
      ? `\n  <Scheduler>\n    <RunEveryNMinutes>${opts.runEveryNMinutes}</RunEveryNMinutes>\n  </Scheduler>`
      : '';
  return (
    `<?xml version="1.0"?>\n` +
    `<QBWCXML>\n` +
    `  <AppName>${appName}</AppName>\n` +
    `  <AppID></AppID>\n` +
    `  <AppURL>${opts.appUrl}</AppURL>\n` +
    `  <AppDescription>${appDesc}</AppDescription>\n` +
    `  <AppSupport>${support}</AppSupport>\n` +
    `  <UserName>${opts.username}</UserName>\n` +
    `  <OwnerID>${ownerId}</OwnerID>\n` +
    `  <FileID>${fileId}</FileID>\n` +
    `  <QBType>QBFS</QBType>\n` +
    `  <IsReadOnly>${readOnly ? 'true' : 'false'}</IsReadOnly>${scheduler}\n` +
    `</QBWCXML>\n`
  );
}
