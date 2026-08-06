// lib/b2b-training.ts
// SERVER-ONLY. B2B distributor training: module loading + exam build/mark.
//
// The exam is marked here and nowhere else — the client only ever receives
// question text + options (buildExam strips `correct`/`explain`), and the
// full answer key comes back exclusively in the POST response after an
// attempt is recorded. Never ship a TrainingModule's questions to the
// browser pre-submit.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface TrainingSection {
  title: string
  intro?: string
  slides: number[]           // 1-based slide numbers → <slideBase>/<NN>.jpg
}

export interface TrainingQuestion {
  q: string
  options: string[]
  correct: number            // index into options
  explain?: string
  slide?: number             // slide the answer comes from
}

export interface TrainingModule {
  id: string
  slug: string
  title: string
  description: string | null
  passPct: number
  enabled: boolean
  sections: TrainingSection[]
  questions: TrainingQuestion[]
  // Full URL prefix for slide images (no trailing filename), e.g.
  // https://<supabase>/storage/v1/object/public/b2b-training-slides/<slug>.
  // null for repo-baked modules → clients fall back to /training/<slug>.
  slideBase: string | null
}

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// Disabled modules load as null by default (distributor-facing callers must
// never see them); the admin "preview as distributor" endpoint passes
// includeDisabled so staff can vet a course before enabling/assigning it.
export async function loadModule(slug: string, opts?: { includeDisabled?: boolean }): Promise<TrainingModule | null> {
  const { data, error } = await svc()
    .from('b2b_training_modules')
    .select('id, slug, title, description, pass_pct, enabled, content')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || (data.enabled === false && !opts?.includeDisabled)) return null
  const content = (data.content || {}) as { sections?: TrainingSection[]; questions?: TrainingQuestion[]; slide_base?: string }
  return {
    id: data.id,
    slug: data.slug,
    title: data.title,
    description: data.description || null,
    passPct: Number(data.pass_pct) || 90,
    enabled: data.enabled !== false,
    sections: Array.isArray(content.sections) ? content.sections : [],
    questions: Array.isArray(content.questions) ? content.questions : [],
    slideBase: typeof content.slide_base === 'string' && content.slide_base ? content.slide_base : null,
  }
}

export function moduleSlideCount(sections: TrainingSection[]): number {
  return sections.reduce((n, s) => n + (Array.isArray(s.slides) ? s.slides.length : 0), 0)
}

// ── Assignment gating (migration 192) ───────────────────────────────────
// Training is ASSIGNED coursework: a module is visible to a membership iff
// it's enabled AND there's either a whole-distributor assignment row
// (distributor_user_id null) for their distributor, or a per-user row for
// their exact b2b_distributor_users row. Zero assignments = invisible.

// The preview session's fallback user id is the literal string 'preview',
// which would 22P02 on a uuid column — normalise to null (whole-distributor
// assignments still apply; per-user ones can't).
export function asMembershipId(userId: string): string | null {
  return /^[0-9a-f-]{36}$/i.test(userId) ? userId : null
}

// Module ids assigned to this membership (whole-distributor + per-user rows).
// NOT filtered on module.enabled — intersect with an enabled-modules query.
export async function assignedModuleIds(distributorId: string, membershipId: string | null): Promise<Set<string>> {
  const { data, error } = await svc()
    .from('b2b_training_assignments')
    .select('module_id, distributor_user_id')
    .eq('distributor_id', distributorId)
  if (error) throw new Error(error.message)
  const ids = new Set<string>()
  for (const r of (data || []) as Array<{ module_id: string; distributor_user_id: string | null }>) {
    if (r.distributor_user_id === null || (membershipId !== null && r.distributor_user_id === membershipId)) {
      ids.add(r.module_id)
    }
  }
  return ids
}

// ── Exam build (client-safe) ────────────────────────────────────────────

// What the browser is allowed to see before submitting: question + options
// in their STORED order (no shuffle of options — `correct` indexes must stay
// meaningful server-side), never `correct` or `explain`.
export interface ExamQuestionSafe {
  q: string
  options: string[]
}

// Deterministic when `seed` is given (mulberry32), Math.random otherwise.
function rng(seed?: number): () => number {
  if (seed == null) return Math.random
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildExam(module: TrainingModule, seed?: number): {
  order: number[]                 // shuffled original-question indexes
  questions: ExamQuestionSafe[]   // aligned with `order`
} {
  const rand = rng(seed)
  const order = module.questions.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {   // Fisher–Yates
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return {
    order,
    questions: order.map(i => ({
      q: module.questions[i].q,
      options: [...module.questions[i].options],
    })),
  }
}

// ── Exam marking (server-side only) ─────────────────────────────────────

export interface MarkedQuestion {
  correct: boolean
  chosen: number | null       // option index the user picked (null = unanswered)
  correctIndex: number
  explain: string | null
  slide: number | null
}

export interface ExamResult {
  scorePct: number            // 0–100, rounded to 1dp
  passed: boolean             // scorePct >= module.passPct
  perQuestion: MarkedQuestion[]  // aligned with module.questions (original order)
}

// `answers` is keyed by ORIGINAL question index (the values in the order
// array the client was given), value = chosen option index.
export function markExam(module: TrainingModule, answers: Record<number, number>): ExamResult {
  const perQuestion: MarkedQuestion[] = module.questions.map((q, i) => {
    const raw = (answers as any)[i]
    const chosen = Number.isInteger(raw) && raw >= 0 && raw < q.options.length ? Number(raw) : null
    return {
      correct: chosen !== null && chosen === q.correct,
      chosen,
      correctIndex: q.correct,
      explain: q.explain || null,
      slide: q.slide ?? null,
    }
  })
  const total = perQuestion.length
  const right = perQuestion.filter(p => p.correct).length
  const scorePct = total === 0 ? 0 : Math.round((right / total) * 1000) / 10
  return { scorePct, passed: scorePct >= module.passPct, perQuestion }
}
