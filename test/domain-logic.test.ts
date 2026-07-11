import { describe, it, expect } from 'vitest';
import { classifyFindings } from '../src/swarmsync/severity.js';
import { classifyDeterministic } from '../src/extract/classify.js';
import { footCheck, computeConfidence, deriveMissingFields, validateRaw, normalizeExtraction } from '../src/extract/model.js';
import { resolveVendor, routeTxnType, similarity } from '../src/mapping/resolve.js';

describe('severity.classifyFindings (Amendment A1.3)', () => {
  it('maps bank change to bank_change_warning (critical)', () => {
    const c = classifyFindings([{ severity: 'critical', pattern: 'BANK_ACCOUNT_CHANGE_DETECTED' }]);
    expect(c.hasCritical).toBe(true);
    expect(c.criticalReason).toBe('bank_change_warning');
  });
  it('maps duplicates to duplicate (critical)', () => {
    const c = classifyFindings([{ severity: 'critical', pattern: 'EXACT_DUPLICATE' }]);
    expect(c.criticalReason).toBe('duplicate');
  });
  it('high findings → fraud_flag; medium → non-blocking', () => {
    expect(classifyFindings([{ severity: 'high', pattern: 'LINE_ITEM_MATH_ERROR' }]).criticalReason).toBe('fraud_flag');
    const med = classifyFindings([{ severity: 'medium', pattern: 'ROUND_DOLLAR_AMOUNT' }]);
    expect(med.hasMedium).toBe(true);
    expect(med.hasCritical).toBe(false);
    expect(med.hasHigh).toBe(false);
  });
});

describe('classifyDeterministic', () => {
  it('classifies by subject keyword', () => {
    expect(classifyDeterministic({ subject: 'Your Invoice 123', fromAddr: 'a@b.com', hasAttachment: true, mimeTypes: ['application/pdf'] }).docType).toBe('invoice');
    expect(classifyDeterministic({ subject: 'Monthly Statement', fromAddr: 'a@b.com', hasAttachment: true, mimeTypes: [] }).docType).toBe('statement');
  });
  it('is not confident with an attachment but no keyword', () => {
    const r = classifyDeterministic({ subject: 'hello', fromAddr: 'a@b.com', hasAttachment: true, mimeTypes: ['application/pdf'] });
    expect(r.confident).toBe(false);
  });
});

describe('extraction model', () => {
  const raw = validateRaw({
    vendor_name: 'Acme', invoice_number: 'INV-1', invoice_date: '2026-07-01', due_date: null,
    total: 110, tax: 10, line_items: [{ description: 'x', amount: 100 }],
    doc_type: 'invoice', direction: 'AP', field_confidence: { vendor_name: 0.9, total: 0.95 },
  });
  it('foot-check passes when total == lines + tax', () => {
    expect(footCheck(raw)).toBe(true);
  });
  it('foot-check fails when totals do not foot', () => {
    const bad = { ...raw, total: 999 };
    expect(footCheck(bad as any)).toBe(false);
    expect(normalizeExtraction(bad as any).flags).toContain('total_mismatch');
  });
  it('derives missing required fields for invoices', () => {
    const miss = validateRaw({ ...raw, invoice_number: null });
    expect(deriveMissingFields(miss)).toContain('invoice_number');
  });
  it('confidence = min(components) − missing penalty', () => {
    expect(computeConfidence(raw, [])).toBeCloseTo(0.9, 5);
    expect(computeConfidence(raw, ['invoice_number'])).toBeCloseTo(0.75, 5);
  });
});

describe('mapping resolver', () => {
  const cands = [{ sourceKey: 'acme building supply', targetId: 'V1', targetName: 'Acme Building Supply' }];
  it('exact prior mapping', () => {
    const r = resolveVendor('Acme Building Supply', null, cands);
    expect(r.status).toBe('exact');
  });
  it('fuzzy match on near-duplicate name', () => {
    const r = resolveVendor('ACME BLDG SUPPLY LLC', null, [{ sourceKey: 'x', targetId: 'V1', targetName: 'Acme Bldg Supply' }]);
    expect(['fuzzy', 'exact']).toContain(r.status);
  });
  it('unknown vendor when no match', () => {
    expect(resolveVendor('Totally Different Co', null, cands).status).toBe('unknown');
  });
  it('routes AP invoice→Bill, AR→Invoice, never Journal Entry', () => {
    expect(routeTxnType('invoice', 'AP', false)).toBe('Bill');
    expect(routeTxnType('receipt', 'AP', true)).toBe('Purchase');
    expect(routeTxnType('invoice', 'AR', false)).toBe('Invoice');
    expect(routeTxnType('receipt', 'AR', true)).toBe('SalesReceipt');
  });
  it('similarity is 1 for identical normalized names', () => {
    expect(similarity('Acme, Inc.', 'ACME inc')).toBeGreaterThan(0.9);
  });
});
