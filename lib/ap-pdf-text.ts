// lib/ap-pdf-text.ts
//
// Best-effort text-layer extraction from an invoice PDF (server-side, via
// the already-bundled pdfjs-dist legacy build). Returns null for scans /
// image-only PDFs / any parse hiccup — callers treat text as a bonus signal,
// never a requirement.

export async function extractPdfText(bytes: Buffer, maxPages = 4): Promise<string | null> {
  try {
    // Legacy build runs in Node with an in-process "fake worker".
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise
    const pages = Math.min(doc.numPages || 0, maxPages)
    const parts: string[] = []
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      parts.push((tc.items || []).map((i: any) => i.str).join(' '))
    }
    try { await doc.destroy() } catch { /* ignore */ }
    const text = parts.join('\n').replace(/\s+/g, ' ').trim()
    return text.length >= 20 ? text : null   // <20 chars = effectively image-only
  } catch {
    return null
  }
}
