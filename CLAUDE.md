# JA Portal — instructions for Claude Code

Project instructions, loaded automatically in every session in this repo.

---

## 1. Keep the documentation current — this is not optional

`docs/HANDOVER.md` and `docs/SOP.md` are the portal's living documentation. They are served to staff in-app at **Admin → Library** (`/admin/library`), so they are not archive material — people read them to do their jobs.

**Any change or progression to the portal must be reflected in them, in the same piece of work that makes the change.** Not "later", not in a follow-up task. A feature that ships undocumented is not finished.

### Which document

| Change | Update |
|---|---|
| How something is **built** — new integration, cron, worker, table, env var, architectural decision, security posture, risk | `docs/HANDOVER.md` |
| How someone **uses** it — a new screen, a changed workflow, a new button that staff must press, a rule they must follow | `docs/SOP.md` |
| Both, when a change alters the mechanism *and* the daily routine | Both |

Most user-visible changes need both. The Ship Now split is the reference example: the handover explains the manifest/pickup mechanics, the SOP tells the warehouse that Book Freight no longer despatches.

### Also update

- **Counts and dates** in the handover header and §9 (route counts, cron count, latest migration, "as of" dates) when they move.
- **§9 Known risks** — add new debt, and *remove* items once they're actually resolved. A stale risk list is worse than none.
- **The SOP's golden rules** (appendix) if the change creates a new way to get something expensively wrong.
- **The troubleshooting table** (SOP §10) if the change introduces a new failure mode with a knowable cause.

### Then regenerate the PDFs

The markdown is the source of truth and the in-app reader renders it live, but the downloadable PDFs are generated artifacts and go stale silently:

```bash
REPO=$PWD node scripts/render-doc-pdf.js docs/SOP.md docs/SOP.pdf \
  "JA Portal — Standard Operating Procedures" \
  "How to use the portal, task by task — for workshop, distributor orders, accounts payable, sales and reporting."

REPO=$PWD node scripts/render-doc-pdf.js docs/HANDOVER.md docs/HANDOVER.pdf \
  "JA Portal — Handover" \
  "How the portal is built, where it runs, every connection it has, and the operating procedures for every module."
```

Needs `npx playwright install chromium` once per machine. Commit the regenerated PDFs alongside the markdown.

### Adding a new document

One row in `lib/library-docs.ts`, drop the `.md` and rendered `.pdf` into `docs/`. Nothing else.

---

## 2. Conventions that are actually enforced

- **UI**: use the shared kit — `lib/ui/theme` (`T` tokens) and `components/ui`. B2B surfaces additionally use the Alloy kit `components/b2b/ui`. Never use browser `alert`/`confirm`/`prompt`; use the Feedback hooks.
- **Theme**: `T` tokens are CSS variables. For transparency use `alpha(color, alphaHex)` — note the second argument is a **hex string** (`'1f'`), not a number.
- **Migrations**: numbered files in `migrations/`. Apply via the Supabase MCP `apply_migration` (project `qtiscbvhlvdvafwtdtcd`) **before** pushing code that depends on the new schema, or production breaks between deploy and migration.
- **Credentials**: resolved DB-first through `lib/integration-config.ts`. Read settings through it, not `process.env` directly, so they stay changeable in the portal.
- **Auth**: pages gate with `requirePageAuth(context, permission)`, API routes with `withAuth(permission, handler)`. Never put anything sensitive in `public/` — it is served to the internet with no sign-in.
- **Runtime file reads**: if a route reads a repo file at runtime, add it to `outputFileTracingIncludes` in `next.config.js`, or Next prunes it from the serverless bundle and it 404s in production while working locally.
- **Commits**: commit *and* push — never stop at a local commit.

---

## 3. Before you say it's done

1. `npx tsc --noEmit` clean.
2. `npm run build` clean for anything touching pages, routing or config.
3. Documentation updated per §1, PDFs regenerated.
4. Report honestly what was verified and what wasn't. "Typechecks and builds" is not "tested against live data" — say which one it is.
