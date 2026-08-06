// lib/b2b-training-generate.ts
// SERVER-ONLY. Document → training-course generator:
//
//   1. Download the staff-uploaded PDF from the private b2b-training-uploads
//      bucket (it got there via a signed direct upload — never through us).
//   2. Render EVERY page to a ~1280px-wide JPEG with pdfjs-dist (legacy
//      build) + @napi-rs/canvas (prebuilt native — Vercel-safe, no sharp),
//      upload each to the PUBLIC b2b-training-slides bucket as
//      <slug>/<NN>.jpg. Page N = slide N. Capped at 80 pages.
//   3. Extract per-page text in the same pdfjs session; if the document is
//      effectively a scan (almost no text layer) the LLM gets up to 20 page
//      IMAGES instead.
//   4. One Anthropic call drafts 4-10 ordered sections + 12-20 multiple-
//      choice questions grounded only in the document. Strict parse +
//      validation; invalid questions dropped; <6 usable = hard fail.
//   5. Insert the b2b_training_modules row as a DISABLED draft with
//      content.slide_base pointing at the storage folder — staff review the
//      quiz on the answer sheet, then enable + assign on the Training page.
//
// Thrown errors carry admin-friendly messages — the generate API route
// forwards them verbatim.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { TrainingQuestion, TrainingSection } from './b2b-training'

export const TRAINING_UPLOADS_BUCKET = 'b2b-training-uploads'
export const TRAINING_SLIDES_BUCKET = 'b2b-training-slides'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const GEN_MODEL = process.env.B2B_TRAINING_GEN_MODEL || 'claude-sonnet-5'
const MAX_PAGES = 80            // pages beyond this are logged + dropped
const TARGET_WIDTH = 1280       // rendered slide width, px
const JPEG_QUALITY = 78
const SPARSE_TEXT_CHARS = 400   // whole-doc text below this = treat as a scan
const MAX_IMAGE_PAGES = 20      // page images sent to the LLM for scans

const pad2 = (n: number) => String(n).padStart(2, '0')

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

// kebab-case, 2–60 chars, no leading/trailing/double hyphens.
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface GenerateInput {
  uploadPath: string   // object path inside b2b-training-uploads
  title: string
  slug: string
  passPct: number
}

export interface GenerateResult {
  slug: string
  questionCount: number
  pageCount: number
}

// ── PDF → page JPEGs + per-page text ─────────────────────────────────────

interface RenderedDoc {
  pageCount: number          // pages actually rendered (post-cap)
  totalPagesInPdf: number
  pageTexts: string[]        // index 0 = page 1
  imagePages: Buffer[]       // first MAX_IMAGE_PAGES JPEGs (scan fallback)
}

async function renderAndUploadPdf(bytes: Buffer, slug: string): Promise<RenderedDoc> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf')
  const { createCanvas } = await import('@napi-rs/canvas')

  // pdfjs draws onto canvases it asks this factory for (pattern/mask
  // scratch surfaces etc.) — hand it @napi-rs/canvas ones.
  class NapiCanvasFactory {
    create(width: number, height: number) {
      const canvas = createCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)))
      return { canvas, context: canvas.getContext('2d') }
    }
    reset(cc: any, width: number, height: number) {
      cc.canvas.width = Math.max(1, Math.floor(width))
      cc.canvas.height = Math.max(1, Math.floor(height))
    }
    destroy(cc: any) {
      cc.canvas.width = 0
      cc.canvas.height = 0
      cc.canvas = null
      cc.context = null
    }
  }
  const canvasFactory = new NapiCanvasFactory()

  // Best-effort standard-font path (Helvetica/Times fallbacks for PDFs that
  // don't embed fonts). Missing = pdfjs warns and substitutes — not fatal.
  let standardFontDataUrl: string | undefined
  try {
    const pathMod = await import('path')
    standardFontDataUrl = pathMod.join(pathMod.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + pathMod.sep
  } catch { /* render without */ }

  let doc: any
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,     // Node: render glyphs as paths, no CSS fonts
      canvasFactory,
      ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    }).promise
  } catch (e: any) {
    throw new Error(`That file could not be read as a PDF (${String(e?.message || e).slice(0, 120)}). Export the document as a standard PDF and try again.`)
  }

  const totalPagesInPdf = Number(doc.numPages) || 0
  if (totalPagesInPdf < 1) throw new Error('The PDF has no pages.')
  const pageCount = Math.min(totalPagesInPdf, MAX_PAGES)
  if (totalPagesInPdf > MAX_PAGES) {
    console.warn(`[training-generate] ${slug}: PDF has ${totalPagesInPdf} pages — truncating to the first ${MAX_PAGES}`)
  }

  const pageTexts: string[] = []
  const imagePages: Buffer[] = []
  const c = svc()

  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p)

    // Render at ~TARGET_WIDTH px wide.
    const base = page.getViewport({ scale: 1 })
    const scale = TARGET_WIDTH / Math.max(1, base.width)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'                       // JPEG has no alpha
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx as any, viewport, canvasFactory }).promise
    const jpeg = await canvas.encode('jpeg', JPEG_QUALITY)

    const { error: upErr } = await c.storage.from(TRAINING_SLIDES_BUCKET)
      .upload(`${slug}/${pad2(p)}.jpg`, jpeg, { contentType: 'image/jpeg', upsert: true })
    if (upErr) throw new Error(`Slide upload failed on page ${p}: ${upErr.message}`)

    if (imagePages.length < MAX_IMAGE_PAGES) imagePages.push(Buffer.from(jpeg))

    // Text layer (same session).
    try {
      const tc = await page.getTextContent()
      pageTexts.push((tc.items || []).map((i: any) => i.str).join(' ').replace(/\s+/g, ' ').trim())
    } catch {
      pageTexts.push('')
    }
    try { page.cleanup() } catch { /* ignore */ }
  }

  try { await doc.destroy() } catch { /* ignore */ }
  return { pageCount, totalPagesInPdf, pageTexts, imagePages }
}

// ── LLM draft ────────────────────────────────────────────────────────────

function systemPrompt(pageCount: number): string {
  return `You are drafting an internal training course for Just Autos' B2B distributor portal from a document. The document's ${pageCount} pages have been rendered as course slides — page N is slide N. Draft the course structure and a quiz.

Output ONLY a JSON object (no markdown fences, no commentary):
{
  "description": "one sentence describing what the course covers",
  "sections": [ { "title": "short section heading", "intro": "1-2 sentence summary of the section", "slides": [page numbers] }, ... ],
  "questions": [ { "q": "question text", "options": ["A","B","C","D"], "correct": 0, "explain": "1-2 sentences on why that answer is right", "slide": pageNumber }, ... ]
}

Rules for "sections": 4-10 sections (fewer only if the document is very short) that group the pages IN ORDER. Every page number from 1 to ${pageCount} must appear exactly once across all sections, in ascending order with no gaps, repeats or omissions. Section boundaries should follow the document's own topic changes.

Rules for "questions": 12-20 multiple-choice questions grounded ONLY in this document — never outside knowledge. Exactly 4 options each; "correct" is the 0-based index of the right option; wrong options must be plausible but clearly wrong per the document; "slide" is the page number where the answer is found. Cover the breadth of the document, not just the first pages.`
}

interface LlmDraft {
  description: string | null
  sections: TrainingSection[]
  questions: TrainingQuestion[]
}

async function draftCourse(rendered: RenderedDoc): Promise<LlmDraft> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const totalText = rendered.pageTexts.join('').replace(/\s+/g, '').length
  const sparse = totalText < SPARSE_TEXT_CHARS

  const content: any[] = []
  if (!sparse) {
    content.push({
      type: 'text',
      text: `Here is the document, page by page:\n\n` +
        rendered.pageTexts.map((t, i) => `--- PAGE ${i + 1} ---\n${t || '(no text on this page)'}`).join('\n\n'),
    })
  } else {
    // Scanned / image-only document: hand over the rendered pages themselves.
    content.push({
      type: 'text',
      text: `This document has little or no extractable text (it is likely a scan or image-based export). It has ${rendered.pageCount} pages; the first ${rendered.imagePages.length} are attached as images (image k = page k). Base the sections and questions on what you can read in the images; pages beyond the attached ones can be grouped into a final section by position.`,
    })
    rendered.imagePages.forEach((buf, i) => {
      content.push({ type: 'text', text: `Page ${i + 1}:` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } })
    })
  }

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: GEN_MODEL,
      max_tokens: 8000,
      system: systemPrompt(rendered.pageCount),
      messages: [{ role: 'user', content }],
    }),
  })
  if (!r.ok) throw new Error(`The AI draft failed (Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}). Try again in a minute.`)
  const data = await r.json()
  const text: string = data.content?.map((b: any) => b.text || '').join('') || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('The AI draft came back in an unexpected format. Try again — this is usually transient.')

  let parsed: any
  try { parsed = JSON.parse(m[0]) } catch {
    throw new Error('The AI draft came back as invalid JSON. Try again — this is usually transient.')
  }

  const sections = normaliseSections(parsed.sections, rendered.pageCount)
  const questions = validateQuestions(parsed.questions, rendered.pageCount)
  if (questions.length < 6) {
    throw new Error(`The AI draft only produced ${questions.length} usable questions (need at least 6). Try again, or use a PDF with clearer content.`)
  }
  return {
    description: parsed.description ? String(parsed.description).trim().slice(0, 300) : null,
    sections,
    questions,
  }
}

// Sections must cover pages 1..pageCount exactly once, in order. The LLM is
// told so, but we repair rather than fail: strip out-of-range/duplicate
// pages, then slot any missing pages back into the section whose pages they
// follow, keeping each section's slides ascending.
function normaliseSections(raw: any, pageCount: number): TrainingSection[] {
  let sections: TrainingSection[] = []
  if (Array.isArray(raw)) {
    const seen = new Set<number>()
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue
      const title = String(s.title || '').trim().slice(0, 120)
      if (!title) continue
      const slides: number[] = []
      for (const v of Array.isArray(s.slides) ? s.slides : []) {
        const n = Number(v)
        if (Number.isInteger(n) && n >= 1 && n <= pageCount && !seen.has(n)) { seen.add(n); slides.push(n) }
      }
      const intro = String(s.intro || '').trim().slice(0, 400)
      sections.push({ title, ...(intro ? { intro } : {}), slides: slides.sort((a, b) => a - b) })
    }
    sections = sections.filter(s => s.slides.length > 0 || sections.length <= 1)

    // Slot missing pages into the section that owns the nearest lower page.
    const owner = new Map<number, number>()   // page → section index
    sections.forEach((s, si) => s.slides.forEach(n => owner.set(n, si)))
    for (let p = 1; p <= pageCount; p++) {
      if (owner.has(p)) continue
      let si = 0
      for (let q = p - 1; q >= 1; q--) { if (owner.has(q)) { si = owner.get(q)!; break } }
      if (sections.length === 0) break
      sections[si].slides.push(p)
      sections[si].slides.sort((a, b) => a - b)
      owner.set(p, si)
    }
    sections = sections.filter(s => s.slides.length > 0)
  }
  if (sections.length === 0) {
    // Total structural failure — one section covering everything beats dying.
    console.warn('[training-generate] LLM sections unusable — falling back to a single section')
    sections = [{ title: 'Course slides', slides: Array.from({ length: pageCount }, (_, i) => i + 1) }]
  }
  return sections
}

// Shape-validate the drafted questions; invalid ones are dropped (logged).
function validateQuestions(raw: any, pageCount: number): TrainingQuestion[] {
  const out: TrainingQuestion[] = []
  if (!Array.isArray(raw)) return out
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const text = String(q.q || '').trim()
    const options = Array.isArray(q.options) ? q.options.map((o: any) => String(o ?? '').trim()) : []
    const correct = Number(q.correct)
    if (!text || options.length !== 4 || options.some((o: string) => !o)) { console.warn('[training-generate] dropped malformed question:', text.slice(0, 60)); continue }
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) { console.warn('[training-generate] dropped question with bad correct index:', text.slice(0, 60)); continue }
    const item: TrainingQuestion = { q: text, options, correct }
    const explain = String(q.explain || '').trim()
    if (explain) item.explain = explain.slice(0, 500)
    const slide = Number(q.slide)
    if (Number.isInteger(slide) && slide >= 1 && slide <= pageCount) item.slide = slide
    out.push(item)
  }
  return out.slice(0, 20)
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function generateTrainingModule(input: GenerateInput): Promise<GenerateResult> {
  const slug = String(input.slug || '').trim().toLowerCase()
  const title = String(input.title || '').trim()
  const uploadPath = String(input.uploadPath || '').trim()
  const passPct = Number(input.passPct)

  if (!uploadPath) throw new Error('uploadPath required')
  if (!title) throw new Error('A course title is required.')
  if (!SLUG_RE.test(slug) || slug.length < 2 || slug.length > 60) {
    throw new Error('Slug must be kebab-case: lowercase letters/numbers separated by single hyphens (e.g. ja103-fitting-guide).')
  }
  if (!Number.isInteger(passPct) || passPct < 1 || passPct > 100) throw new Error('Pass mark must be a whole number between 1 and 100.')

  const c = svc()

  // Slug must be unique — it names both the module and its slide folder.
  const { data: existing, error: exErr } = await c.from('b2b_training_modules')
    .select('id').eq('slug', slug).maybeSingle()
  if (exErr) throw new Error(exErr.message)
  if (existing) throw new Error(`The slug "${slug}" is already taken by another course — pick a different one.`)

  // Fetch the uploaded PDF.
  const { data: blob, error: dlErr } = await c.storage.from(TRAINING_UPLOADS_BUCKET).download(uploadPath)
  if (dlErr || !blob) throw new Error(`Could not read the uploaded file (${dlErr?.message || 'not found'}). Upload it again.`)
  const bytes = Buffer.from(await blob.arrayBuffer())
  if (bytes.length < 100) throw new Error('The uploaded file is empty or truncated. Upload it again.')

  // Render + upload every page, extract text.
  const rendered = await renderAndUploadPdf(bytes, slug)

  // Draft sections + quiz.
  const draft = await draftCourse(rendered)

  // Save as a disabled draft for review.
  const slideBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${TRAINING_SLIDES_BUCKET}/${slug}`
  const { error: insErr } = await c.from('b2b_training_modules').insert({
    slug,
    title,
    description: draft.description,
    pass_pct: passPct,
    enabled: false,               // DRAFT — staff review, then enable + assign
    content: {
      sections: draft.sections,
      questions: draft.questions,
      slide_base: slideBase,
      source: { upload_path: uploadPath, generated_at: new Date().toISOString(), model: GEN_MODEL },
    },
  })
  if (insErr) {
    if (/duplicate|unique/i.test(insErr.message)) throw new Error(`The slug "${slug}" is already taken by another course — pick a different one.`)
    throw new Error(`Could not save the course: ${insErr.message}`)
  }

  return { slug, questionCount: draft.questions.length, pageCount: rendered.pageCount }
}
