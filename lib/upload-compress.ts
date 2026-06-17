// lib/upload-compress.ts
// Client-side upload compression (B2B catalogue images + PDFs). Returns the
// original untouched if compression isn't applicable or wouldn't help.

export interface CompressedFile { blob: Blob; name: string; mime: string }

// Downscale + re-encode large images to JPEG. Skips small images and formats
// the canvas can't decode (HEIC/GIF/SVG). Flattens transparency onto white.
export async function compressImage(file: File, opts?: { maxEdge?: number; quality?: number }): Promise<CompressedFile> {
  const asIs: CompressedFile = { blob: file, name: file.name, mime: file.type }
  const maxEdge = opts?.maxEdge ?? 1600
  const quality = opts?.quality ?? 0.82
  if (!file.type.startsWith('image/') || /heic|heif|gif|svg/i.test(file.type) || file.size < 300 * 1024) return asIs
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) { bmp.close(); return asIs }
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h)   // white bg so transparent PNGs don't go black
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality))
    if (!blob || blob.size >= file.size) return asIs
    return { blob, name: file.name.replace(/\.[A-Za-z0-9]+$/, '') + '.jpg', mime: 'image/jpeg' }
  } catch { return asIs }
}

// Best-effort PDF shrink. Two stages, escalating only as needed:
//   1. Structural re-save through pdf-lib (object streams) — drops unused
//      objects. Cheap, lossless, but can't recompress scanned/image PDFs.
//   2. If still over `maxBytes`, RASTERISE: render each page with pdf.js and
//      re-encode as JPEG into a fresh PDF. Lossy (text becomes an image) but
//      shrinks 40 MB+ scans to a few MB. Only runs when stage 1 isn't enough.
// Returns the smallest result; never larger than the original.
export async function compressPdf(file: File, opts?: { maxBytes?: number; dpi?: number; quality?: number }): Promise<CompressedFile> {
  const maxBytes = opts?.maxBytes ?? Infinity
  let best: CompressedFile = { blob: file, name: file.name, mime: 'application/pdf' }
  try {
    const { PDFDocument } = await import('pdf-lib')
    const bytes = await file.arrayBuffer()
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const out = await doc.save({ useObjectStreams: true })
    if (out.byteLength < best.blob.size) best = { blob: new Blob([out], { type: 'application/pdf' }), name: file.name, mime: 'application/pdf' }
  } catch { /* keep original */ }

  if (best.blob.size <= maxBytes) return best

  // Still too big — rasterise the original and keep whichever is smaller.
  const r = await rasterizePdf(file, opts)
  return r.blob.size < best.blob.size ? r : best
}

// Render every page of a PDF to a JPEG via pdf.js and rebuild a (much smaller)
// image-only PDF. Used as the fallback for scanned/image-heavy PDFs that the
// structural re-save can't shrink. Falls back to the original on any error.
// NOTE: the worker is self-hosted at /public/pdf.worker.min.js — if pdfjs-dist
// is ever bumped, re-copy build/pdf.worker.min.js into public/ to match.
export async function rasterizePdf(file: File, opts?: { dpi?: number; quality?: number }): Promise<CompressedFile> {
  const asIs: CompressedFile = { blob: file, name: file.name, mime: 'application/pdf' }
  if (typeof document === 'undefined') return asIs   // client-only
  const dpi = opts?.dpi ?? 130
  const quality = opts?.quality ?? 0.7
  const scale = dpi / 72   // pdf.js viewport is 72 DPI at scale 1
  try {
    const pdfjs: any = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js'
    const { PDFDocument } = await import('pdf-lib')

    const data = new Uint8Array(await file.arrayBuffer())
    const pdf = await pdfjs.getDocument({ data }).promise
    const outDoc = await PDFDocument.create()

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')
      if (!ctx) { canvas.width = 0; canvas.height = 0; continue }
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      const jpg: Blob | null = await new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', quality))
      if (jpg) {
        const img = await outDoc.embedJpg(new Uint8Array(await jpg.arrayBuffer()))
        // Keep the original page size (points) so the doc reads the same.
        const pw = canvas.width / scale
        const ph = canvas.height / scale
        outDoc.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph })
      }
      canvas.width = 0; canvas.height = 0   // release memory between pages
      page.cleanup()
    }

    if (outDoc.getPageCount() === 0) return asIs
    const out = await outDoc.save()
    if (out.byteLength >= file.size) return asIs
    return { blob: new Blob([out], { type: 'application/pdf' }), name: file.name, mime: 'application/pdf' }
  } catch { return asIs }
}
