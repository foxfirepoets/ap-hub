/**
 * Deterministic classifier (CHUNK_5). Rules first — sender domain, subject regex,
 * has-attachment/MIME. Only ambiguous cases fall back to a single LLM call.
 */

export type DocTypeGuess = 'invoice' | 'receipt' | 'statement' | 'payment_confirmation' | 'w9' | 'other';
export type DirectionGuess = 'AP' | 'AR';

export interface ClassifyInput {
  subject: string;
  fromAddr: string;
  hasAttachment: boolean;
  mimeTypes: string[];
}

export interface ClassifyResult {
  docType: DocTypeGuess;
  direction: DirectionGuess;
  confident: boolean;
}

const SUBJECT_RULES: Array<{ re: RegExp; docType: DocTypeGuess }> = [
  { re: /\bstatement\b/i, docType: 'statement' },
  { re: /\b(remittance|payment\s+confirmation|payment\s+received|paid)\b/i, docType: 'payment_confirmation' },
  { re: /\breceipt\b/i, docType: 'receipt' },
  { re: /\binvoice\b/i, docType: 'invoice' },
  { re: /\bw-?9\b/i, docType: 'w9' },
];

export function classifyDeterministic(input: ClassifyInput): ClassifyResult {
  for (const rule of SUBJECT_RULES) {
    if (rule.re.test(input.subject)) {
      // AR only when we're clearly the seller — default AP for received vendor mail.
      const direction: DirectionGuess = /\b(your invoice|invoice to you|you owe)\b/i.test(input.subject)
        ? 'AR'
        : 'AP';
      return { docType: rule.docType, direction, confident: true };
    }
  }
  // Has a PDF/image attachment but no keyword → likely an invoice, but not confident.
  if (input.hasAttachment && input.mimeTypes.some((m) => /pdf|image\//i.test(m))) {
    return { docType: 'invoice', direction: 'AP', confident: false };
  }
  return { docType: 'other', direction: 'AP', confident: false };
}
