import { z } from 'zod';

/**
 * Strict extraction schema (CHUNK_5). LLM-vision output is validated against this;
 * invalid output is retried and never persisted raw.
 */

export const DocType = z.enum([
  'invoice',
  'receipt',
  'statement',
  'payment_confirmation',
  'w9',
  'other',
]);
export const Direction = z.enum(['AP', 'AR']);

export const LineItem = z.object({
  description: z.string().default(''),
  qty: z.number().nullable().optional(),
  unit_price: z.number().nullable().optional(),
  amount: z.number(),
  account_hint: z.string().nullable().optional(),
});

const conf = z.number().min(0).max(1);

export const RawExtractionSchema = z.object({
  vendor_name: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  due_date: z.string().nullable(),
  total: z.number().nullable(),
  tax: z.number().nullable(),
  line_items: z.array(LineItem).default([]),
  payment_terms: z.string().nullable().optional(),
  remit_to: z.string().nullable().optional(),
  bank_info: z.string().nullable().optional(),
  job_ref: z.string().nullable().optional(),
  class_hint: z.string().nullable().optional(),
  location_hint: z.string().nullable().optional(),
  account_hint: z.string().nullable().optional(),
  doc_type: DocType,
  direction: Direction,
  field_confidence: z.record(z.string(), conf).default({}),
});

export type RawExtraction = z.infer<typeof RawExtractionSchema>;
export type LineItemT = z.infer<typeof LineItem>;

export interface ExtractionResult extends RawExtraction {
  confidence: number;
  missing_fields: string[];
  flags: string[];
}

export const REQUIRED_FIELDS_FOR_INVOICE = ['vendor_name', 'invoice_number', 'invoice_date', 'total'];
