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

// Best-effort PDF shrink: re-save through pdf-lib with object streams, which
// drops unused objects and compresses the object structure. It can't recompress
// scanned/image-heavy PDFs much, so we keep the original if it doesn't help.
export async function compressPdf(file: File): Promise<CompressedFile> {
  const asIs: CompressedFile = { blob: file, name: file.name, mime: 'application/pdf' }
  try {
    const { PDFDocument } = await import('pdf-lib')
    const bytes = await file.arrayBuffer()
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const out = await doc.save({ useObjectStreams: true })
    if (out.byteLength >= file.size) return asIs
    return { blob: new Blob([out], { type: 'application/pdf' }), name: file.name, mime: 'application/pdf' }
  } catch { return asIs }
}
