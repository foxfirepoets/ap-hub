import { describe, it, expect, beforeEach } from 'vitest';
import {
  companyQueryRq,
  vendorQueryRq,
  billAddRq,
  isWriteRequest,
  parseQbxmlResponse,
  xmlEscape,
} from '../src/qbdesktop/qbxml.js';
import {
  QbwcSession,
  WriteNotAllowedError,
  resetSessions,
  enqueueForNextRun,
  pendingCount,
} from '../src/qbdesktop/session.js';
import { handleQbwcSoap, detectMethod } from '../src/qbdesktop/soap.js';
import { generateQwc } from '../src/qbdesktop/qwc.js';

describe('qbxml builders + parser', () => {
  it('wraps requests in the qbXML envelope with the version PI', () => {
    const x = companyQueryRq();
    expect(x).toContain('<?qbxml version="16.0"?>');
    expect(x).toContain('<QBXMLMsgsRq onError="stopOnError">');
    expect(x).toContain('<CompanyQueryRq');
  });

  it('detects write vs read requests', () => {
    expect(isWriteRequest(companyQueryRq())).toBe(false);
    expect(isWriteRequest(vendorQueryRq())).toBe(false);
    expect(
      isWriteRequest(
        billAddRq({ vendorName: 'Acme', lines: [{ accountFullName: 'Utilities', amount: 10 }] }),
      ),
    ).toBe(true);
  });

  it('formats a BillAdd with escaped fields and 2dp money', () => {
    const x = billAddRq({
      vendorName: 'Bob & Sons <LLC>',
      refNumber: 'INV-1',
      txnDate: '2026-07-22',
      lines: [{ accountFullName: 'Office Supplies', amount: 12.5, memo: 'pens' }],
    });
    expect(x).toContain('<FullName>Bob &amp; Sons &lt;LLC&gt;</FullName>');
    expect(x).toContain('<Amount>12.50</Amount>');
    expect(x).toContain('<RefNumber>INV-1</RefNumber>');
  });

  it('parses response status and ok flag', () => {
    const okXml = '<QBXML><QBXMLMsgsRs><CompanyQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><CompanyRet/></CompanyQueryRs></QBXMLMsgsRs></QBXML>';
    const r = parseQbxmlResponse(okXml);
    expect(r.ok).toBe(true);
    expect(r.statuses[0]?.statusCode).toBe('0');

    const errXml = '<QBXMLMsgsRs><BillAddRs requestID="2" statusCode="3140" statusSeverity="Error" statusMessage="bad ref"/></QBXMLMsgsRs>';
    expect(parseQbxmlResponse(errXml).ok).toBe(false);
  });

  it('xmlEscape covers all five entities', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

describe('QbwcSession read-only guard', () => {
  it('refuses a write request in read-only mode', () => {
    const s = new QbwcSession('t1', 'readonly');
    expect(() => s.enqueue('bad', billAddRq({ vendorName: 'X', lines: [{ accountFullName: 'A', amount: 1 }] }))).toThrow(
      WriteNotAllowedError,
    );
    // reads are fine
    expect(() => s.enqueue('ok', companyQueryRq())).not.toThrow();
  });

  it('allows a write request in write mode and tracks progress', () => {
    const s = new QbwcSession('t2', 'write');
    s.enqueue('bill', billAddRq({ vendorName: 'X', lines: [{ accountFullName: 'A', amount: 1 }] }));
    expect(s.progress()).toBe(0);
    const item = s.next();
    expect(item?.status).toBe('sent');
    s.record('<QBXML><QBXMLMsgsRs><BillAddRs statusCode="0"/></QBXMLMsgsRs></QBXML>');
    expect(s.done).toBe(true);
    expect(s.progress()).toBe(100);
  });
});

describe('QBWC SOAP protocol', () => {
  beforeEach(() => resetSessions());
  const auth = { username: 'aphub', password: 'secret', mode: 'readonly' as const, makeTicket: () => 'TICKET-1' };

  it('detects each method name', () => {
    expect(detectMethod('<ns:authenticate><strUserName>a</strUserName></ns:authenticate>')).toBe('authenticate');
    expect(detectMethod('<sendRequestXML><ticket>t</ticket></sendRequestXML>')).toBe('sendRequestXML');
  });

  it('rejects bad credentials with nvu', () => {
    const body = '<authenticate><strUserName>aphub</strUserName><strPassword>wrong</strPassword></authenticate>';
    const out = handleQbwcSoap(body, auth);
    expect(out.contentType).toContain('text/xml');
    expect(out.body).toContain('nvu');
  });

  it('authenticates, dispenses queued qbXML, records the response, and closes', () => {
    // Queue a read-only verify BEFORE the connector authenticates.
    enqueueForNextRun('verify', companyQueryRq('c1'));
    expect(pendingCount()).toBe(1);

    const authOut = handleQbwcSoap('<authenticate><strUserName>aphub</strUserName><strPassword>secret</strPassword></authenticate>', auth);
    expect(authOut.body).toContain('<string>TICKET-1</string>');
    // work exists => target is "" (current company file), not "none"
    expect(authOut.body).not.toContain('none');

    const sendOut = handleQbwcSoap('<sendRequestXML><ticket>TICKET-1</ticket></sendRequestXML>', auth);
    expect(sendOut.body).toContain('CompanyQueryRq');

    const recvOut = handleQbwcSoap(
      '<receiveResponseXML><ticket>TICKET-1</ticket><response>&lt;QBXML&gt;&lt;QBXMLMsgsRs&gt;&lt;CompanyQueryRs statusCode="0"/&gt;&lt;/QBXMLMsgsRs&gt;&lt;/QBXML&gt;</response><hresult></hresult><message></message></receiveResponseXML>',
      auth,
    );
    expect(recvOut.body).toContain('<receiveResponseXMLResult>100</receiveResponseXMLResult>');

    const closeOut = handleQbwcSoap('<closeConnection><ticket>TICKET-1</ticket></closeConnection>', auth);
    expect(closeOut.body).toContain('sync complete');
  });

  it('authenticate returns none when there is no queued work', () => {
    const out = handleQbwcSoap('<authenticate><strUserName>aphub</strUserName><strPassword>secret</strPassword></authenticate>', auth);
    expect(out.body).toContain('none');
  });
});

describe('.QWC generation', () => {
  it('marks IsReadOnly true in read-only mode and false in write mode', () => {
    const ro = generateQwc({ appUrl: 'http://localhost:3001/qbwc', username: 'aphub', mode: 'readonly', ownerId: 'a', fileId: 'b' });
    expect(ro).toContain('<IsReadOnly>true</IsReadOnly>');
    expect(ro).toContain('<AppURL>http://localhost:3001/qbwc</AppURL>');
    expect(ro).toContain('<OwnerID>{a}</OwnerID>');

    const rw = generateQwc({ appUrl: 'http://localhost:3001/qbwc', username: 'aphub', mode: 'write', ownerId: 'a', fileId: 'b' });
    expect(rw).toContain('<IsReadOnly>false</IsReadOnly>');
  });
});
