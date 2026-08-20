// Renders a markdown file to PDF: marked -> styled HTML -> Playwright print.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { chromium } = require(path.join(process.env.REPO, 'node_modules', 'playwright'))

const [, , mdPath, pdfPath, docTitle, docSubtitle] = process.argv
const REPO = process.env.REPO

const html = execFileSync('npx', ['-y', 'marked@12', '-i', mdPath], {
  encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024,
})

const CSS = `
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 10.2pt;
         line-height: 1.55; color: #1a1d23; margin: 0; }
  .cover { page-break-after: always; padding-top: 62mm; }
  .cover .kicker { font-size: 11pt; letter-spacing: .22em; text-transform: uppercase; color: #2563eb; font-weight: 700; }
  .cover h1 { font-size: 30pt; line-height: 1.12; margin: 10px 0 12px; letter-spacing: -.4px; }
  .cover .sub { font-size: 12pt; color: #4b5563; max-width: 118mm; }
  .cover .meta { margin-top: 24mm; font-size: 9.5pt; color: #6b7280; border-top: 1px solid #d1d5db; padding-top: 8px; }
  h1, h2, h3, h4 { line-height: 1.25; page-break-after: avoid; }
  h1 { font-size: 19pt; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2px solid #2563eb; }
  h2 { font-size: 14.5pt; margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d1d5db; }
  h3 { font-size: 11.8pt; margin: 15px 0 5px; color: #1f2937; }
  h4 { font-size: 10.6pt; margin: 12px 0 4px; color: #374151; }
  p, li { orphans: 3; widows: 3; }
  p { margin: 0 0 8px; }
  ul, ol { margin: 0 0 9px; padding-left: 19px; }
  li { margin-bottom: 3.5px; }
  li > ul, li > ol { margin-top: 3.5px; }
  code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 8.9pt;
         background: #f3f4f6; padding: 1px 4px; border-radius: 3px; color: #111827;
         word-break: break-word; }
  pre { background: #f9fafb; border: 1px solid #e5e7eb; border-left: 3px solid #2563eb;
        border-radius: 4px; padding: 9px 11px; overflow: hidden; page-break-inside: avoid; margin: 0 0 10px; }
  pre code { background: none; padding: 0; font-size: 8pt; line-height: 1.4; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 11px; font-size: 9.1pt;
          page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: #eef2f7; text-align: left; font-weight: 700; color: #1f2937; }
  th, td { border: 1px solid #d8dee6; padding: 4.5px 7px; vertical-align: top; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  blockquote { margin: 0 0 10px; padding: 6px 12px; border-left: 3px solid #d97706;
               background: #fffbeb; color: #4b5563; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 18px 0; }
  a { color: #1d4ed8; text-decoration: none; word-break: break-word; }
  strong { color: #111827; }
`

const page = `<!doctype html><html><head><meta charset="utf-8"><title>${docTitle}</title>
<style>${CSS}</style></head><body>
<div class="cover">
  <div class="kicker">Just Autos</div>
  <h1>${docTitle}</h1>
  <div class="sub">${docSubtitle}</div>
  <div class="meta">Compiled 20 August 2026 · justautos.app · Internal — not for distribution outside Just Autos</div>
</div>
${html}
</body></html>`

;(async () => {
  const browser = await chromium.launch()
  const p = await browser.newPage()
  await p.setContent(page, { waitUntil: 'load' })
  await p.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:8pt;color:#9ca3af;padding:0 16mm;font-family:Segoe UI,Arial,sans-serif;display:flex;justify-content:space-between;">' +
      `<span>${docTitle}</span><span class="pageNumber"></span></div>`,
  })
  await browser.close()
  console.log('wrote', pdfPath, fs.statSync(pdfPath).size, 'bytes')
})().catch(e => { console.error(e.message); process.exit(1) })
