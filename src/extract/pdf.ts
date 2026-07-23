/**
 * PDF -> PNG page rendering (MuPDF WASM — cross-platform, no native build).
 *
 * Anthropic accepts a PDF document directly, but OpenAI-compatible providers
 * (OpenAI, Ollama/LM Studio vision models, OpenRouter, ...) only take images.
 * So for those we render each page to a PNG and send them as image inputs —
 * "full PDF support" on any vision backend.
 */

/** Render up to `maxPages` of a PDF to PNG page images. */
export async function renderPdfToPngs(pdf: Buffer, maxPages = 8, scale = 2.0): Promise<Buffer[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(pdf), 'application/pdf');
  const total = doc.countPages();
  const n = Math.min(total, maxPages);
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    out.push(Buffer.from(pix.asPNG()));
  }
  return out;
}
