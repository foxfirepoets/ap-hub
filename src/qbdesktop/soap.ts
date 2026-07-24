/**
 * QuickBooks Web Connector SOAP protocol handler.
 *
 * QBWC drives the exchange by calling these SOAP methods in order:
 *   clientVersion / serverVersion  -> version handshake
 *   authenticate                   -> credentials -> [ticket, companyFile|""|"nvu"|"none"]
 *   sendRequestXML                 -> we hand it the next qbXML request ("" = done)
 *   receiveResponseXML             -> it hands back the qbXML response -> % complete
 *   getLastError / connectionError -> diagnostics
 *   closeConnection                -> teardown
 *
 * We parse the SOAP body with focused regexes (no XML/SOAP dependency) and emit
 * the exact envelope shape QBWC expects (namespace http://developer.intuit.com/).
 * Every branch is unit-tested by feeding representative SOAP bodies.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import {
  createSession,
  getSession,
  endSession,
  type QbDesktopMode,
} from './session.js';

const NS = 'http://developer.intuit.com/';

export interface QbwcAuth {
  username: string;
  password: string;
  mode: QbDesktopMode;
  /** "" = use the company file currently open in QuickBooks. */
  companyFile?: string;
  /** Deterministic in tests; defaults to a random UUID. */
  makeTicket?: () => string;
}

export interface SoapReply {
  status: number;
  contentType: string;
  body: string;
}

const QBWC_METHODS = [
  'serverVersion',
  'clientVersion',
  'authenticate',
  'sendRequestXML',
  'receiveResponseXML',
  'connectionError',
  'getLastError',
  'closeConnection',
] as const;
type QbwcMethod = (typeof QBWC_METHODS)[number];

/** Text content of the first <tag>…</tag> (namespace-agnostic) in `xml`. */
function tagText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : undefined;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Detect which QBWC method the SOAP body is invoking. */
export function detectMethod(soapBody: string): QbwcMethod | null {
  for (const m of QBWC_METHODS) {
    if (new RegExp(`<(?:\\w+:)?${m}\\b`).test(soapBody)) return m;
  }
  return null;
}

function envelope(inner: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n` +
    `  <soap:Body>\n${inner}\n  </soap:Body>\n</soap:Envelope>`
  );
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stringResult(method: QbwcMethod, value: string): string {
  return envelope(
    `    <${method}Response xmlns="${NS}"><${method}Result>${esc(value)}</${method}Result></${method}Response>`,
  );
}

function intResult(method: QbwcMethod, value: number): string {
  return envelope(
    `    <${method}Response xmlns="${NS}"><${method}Result>${value}</${method}Result></${method}Response>`,
  );
}

function stringArrayResult(method: QbwcMethod, values: string[]): string {
  const items = values.map((v) => `      <string>${esc(v)}</string>`).join('\n');
  return envelope(
    `    <${method}Response xmlns="${NS}"><${method}Result>\n${items}\n    </${method}Result></${method}Response>`,
  );
}

const reply = (body: string): SoapReply => ({ status: 200, contentType: 'text/xml; charset=utf-8', body });

/**
 * Handle one QBWC SOAP request. `deps` carries the expected credentials, the
 * session mode (read-only vs write), and the company-file target. Returns the
 * SOAP envelope to write back with content-type text/xml.
 */
export function handleQbwcSoap(soapBody: string, deps: QbwcAuth): SoapReply {
  const method = detectMethod(soapBody);
  const makeTicket = deps.makeTicket ?? (() => cryptoRandomId());

  switch (method) {
    case 'serverVersion':
      return reply(stringResult('serverVersion', 'ap-hub-qbwc/0.1.0'));

    case 'clientVersion':
      // "" = accept the connector's version (no warning/upgrade required).
      return reply(stringResult('clientVersion', ''));

    case 'authenticate': {
      const user = tagText(soapBody, 'strUserName')?.trim() ?? '';
      const pass = tagText(soapBody, 'strPassword')?.trim() ?? '';
      if (user !== deps.username || pass !== deps.password) {
        // "nvu" = not a valid user. No ticket work happens.
        return reply(stringArrayResult('authenticate', [makeTicket(), 'nvu']));
      }
      const ticket = makeTicket();
      const session = createSession(ticket, deps.mode);
      // "" = current company file; "none" = nothing to do this run.
      const target = session.all().length === 0 ? 'none' : (deps.companyFile ?? '');
      return reply(stringArrayResult('authenticate', [ticket, target]));
    }

    case 'sendRequestXML': {
      const ticket = tagText(soapBody, 'ticket')?.trim() ?? '';
      const session = getSession(ticket);
      const item = session?.next();
      // "" tells QBWC there is no (more) work.
      return reply(stringResult('sendRequestXML', item ? item.qbxml : ''));
    }

    case 'receiveResponseXML': {
      const ticket = tagText(soapBody, 'ticket')?.trim() ?? '';
      const responseRaw = tagText(soapBody, 'response') ?? '';
      const hresult = tagText(soapBody, 'hresult')?.trim() ?? '';
      const session = getSession(ticket);
      if (!session) {
        // Unknown/expired ticket (e.g. the service restarted mid-sync; sessions
        // are in-process). -1 tells QBWC to stop; log it so it is diagnosable.
        logger.warn({ ticket }, 'qbwc receiveResponseXML for unknown session (aborting run)');
        return reply(intResult('receiveResponseXML', -1));
      }
      session.record(unescapeXml(responseRaw), hresult !== '');
      // <100 => QBWC calls sendRequestXML again; 100 => done.
      return reply(intResult('receiveResponseXML', session.done ? 100 : session.progress()));
    }

    case 'getLastError': {
      const ticket = tagText(soapBody, 'ticket')?.trim() ?? '';
      const session = getSession(ticket);
      const errored = session?.all().find((i) => i.status === 'error');
      return reply(stringResult('getLastError', errored?.error ?? 'No work / no error.'));
    }

    case 'connectionError':
      // "done" tells QBWC to stop (do not retry another URL).
      return reply(stringResult('connectionError', 'done'));

    case 'closeConnection': {
      const ticket = tagText(soapBody, 'ticket')?.trim() ?? '';
      endSession(ticket);
      return reply(stringResult('closeConnection', 'ap-hub sync complete.'));
    }

    default:
      return { status: 500, contentType: 'text/xml; charset=utf-8', body: envelope('    <soap:Fault><faultstring>Unknown QBWC method</faultstring></soap:Fault>') };
  }
}

function cryptoRandomId(): string {
  // A GUID-shaped ticket for the connector session.
  return randomUUID();
}
