// lib/library-docs.ts
// SERVER-ONLY registry for the admin Library (/admin/library).
//
// The documents live in docs/ as markdown (the editable source) alongside a
// rendered PDF. The Library reads both straight off disk: the markdown becomes
// the on-screen reader, the PDF is what people download.
//
// Adding a document = drop the .md and .pdf into docs/, add a row here. Nothing
// else needs touching. If you add one, regenerate its PDF with
//   REPO=$PWD node scripts/render-doc-pdf.js docs/X.md docs/X.pdf "Title" "Sub"
//
// NOTE: docs/** is force-included in the serverless bundle via
// outputFileTracingIncludes in next.config.js — Next's tracer can't see these
// reads because the paths are built at runtime. If a doc 404s in production but
// works locally, that config is the first thing to check.

import fs from 'fs'
import path from 'path'

export interface LibraryDoc {
  slug: string
  title: string
  /** One line, shown on the Library card. */
  description: string
  /** Who it's for — shown as a hint under the title. */
  audience: string
  md: string
  pdf: string
  /** Sensitive docs are called out in the UI so nobody forwards them casually. */
  confidential?: boolean
  /**
   * Filename (no extension) the PDF saves as. Set it for anything that leaves
   * the building: the file lands in someone else's inbox with this name on it.
   * Defaults to the slug, which is safe but ugly.
   */
  downloadName?: string
}

export const LIBRARY_DOCS: LibraryDoc[] = [
  {
    slug: 'sop',
    title: 'Standard Operating Procedures',
    description: 'How to use the portal, task by task — bookings through to invoicing, distributor despatch, AP, the follow-up cadence and reporting.',
    audience: 'All staff',
    md: 'docs/SOP.md',
    pdf: 'docs/SOP.pdf',
    downloadName: 'JA-Portal-SOP',
  },
  {
    slug: 'distributor-app-install',
    title: 'Installing the Just Autos Wholesale app',
    description: 'Step-by-step install for distributors — iPhone, Android, Windows and Mac — plus turning on order notifications. Written to be sent to them as-is.',
    audience: 'Distributors (send them the PDF)',
    md: 'docs/distributor-app-install-sop.md',
    pdf: 'docs/distributor-app-install-sop.pdf',
    // This one is emailed to distributors - it must arrive named as what it is.
    downloadName: 'Just-Autos-Wholesale-App-Install-Guide',
  },
  {
    slug: 'md-activecampaign-bridge',
    title: 'Bridging Mechanics Desk and ActiveCampaign',
    description: 'What connected the two systems before, what was missing, and the nightly reconciliation that now closes deals as Won or Lost. Includes where the pipeline figures moved and why.',
    audience: 'Sales & management',
    md: 'docs/md-activecampaign-bridge.md',
    pdf: 'docs/md-activecampaign-bridge.pdf',
    downloadName: 'JA-Mechanics-Desk-ActiveCampaign-Bridge',
  },
  {
    slug: 'handover',
    title: 'Full Handover Document',
    description: 'How the portal is built, where it runs, every integration and credential location, the scheduled automation, and known risks.',
    audience: 'Admins & technical',
    md: 'docs/HANDOVER.md',
    pdf: 'docs/HANDOVER.pdf',
    confidential: true,
    downloadName: 'JA-Portal-Handover',
  },
]

export function findDoc(slug: string | string[] | undefined): LibraryDoc | null {
  if (typeof slug !== 'string') return null
  return LIBRARY_DOCS.find(d => d.slug === slug) || null
}

const abs = (rel: string) => path.join(process.cwd(), rel)

export function readMarkdown(doc: LibraryDoc): string {
  return fs.readFileSync(abs(doc.md), 'utf8')
}

export function readPdf(doc: LibraryDoc): Buffer {
  return fs.readFileSync(abs(doc.pdf))
}

/** Card metadata. Never throws — a missing file shows as unavailable rather
 *  than breaking the whole Library listing. */
export function docStats(doc: LibraryDoc): { updatedAt: string | null; pdfKb: number | null } {
  try {
    const mdStat = fs.statSync(abs(doc.md))
    let pdfKb: number | null = null
    try { pdfKb = Math.round(fs.statSync(abs(doc.pdf)).size / 1024) } catch { /* pdf not built */ }
    return { updatedAt: mdStat.mtime.toISOString(), pdfKb }
  } catch {
    return { updatedAt: null, pdfKb: null }
  }
}
