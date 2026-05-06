# Just Autos Management Portal

Updated from phone-driven Claude Code session — 7 May 2026

Live management dashboard for JAWS and VPS — built on Next.js, deployed on Vercel.
Connects live to MYOB AccountRight via CData Connect Cloud. Includes an AI chatbot powered by Claude.

> Claude MCP write access verified — 7 May 2026

---

## Stack

- **Framework**: Next.js 14 (React)
- **Hosting**: Vercel
- **Data**: CData Connect Cloud → MYOB AccountRight (JAWS + VPS)
- **AI**: Anthropic Claude API (server-proxied — key never reaches browser)
- **Auth**: Cookie-based password protection (upgradeable to Google SSO)

---

## Deployment — Step by Step

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial portal"
git remote add origin https://github.com/YOUR_ORG/ja-portal.git
git push -u origin main
```

### 2. Create Vercel project

1. Go to https://vercel.com → New Project
2. Import the GitHub repo
3. Framework: **Next.js** (auto-detected)
4. Click **Deploy** — first deploy will fail (no env vars yet — that's fine)

### 3. Set environment variables in Vercel

Go to: Vercel → ja-portal → Settings → Environment Variables

Add each of these:

| Variable | Value | Where to get it |
|---|---|---|
| `CDATA_BASE_URL` | `https://cloud.cdata.com/api/odata4` | Fixed value |
| `CDATA_USERNAME` | Your CData username | cloud.cdata.com → Account |
| `CDATA_PAT` | Your CData Personal Access Token | cloud.cdata.com → API → Tokens |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | console.anthropic.com → API Keys |
| `PORTAL_PASSWORD` | Choose a strong password | You decide — share with team |

Set all variables for **Production**, **Preview**, and **Development**.

### 4. Redeploy

Vercel → ja-portal → Deployments → ⋯ → Redeploy

### 5. Add custom domain (optional)

Vercel → Settings → Domains → Add `portal.justautos.com.au`
Then add the CNAME record at your DNS provider.

---

## Local Development

```bash
# Clone the repo
git clone https://github.com/YOUR_ORG/ja-portal.git
cd ja-portal

# Install dependencies
npm install

# Create local env file
cp .env.example .env.local
# Edit .env.local with real values

# Run dev server
npm run dev
# Open http://localhost:3000
```

---

## Architecture

```
Browser
  │
  ├─ GET /           → pages/index.tsx (React UI)
  ├─ POST /api/auth/login    → lib/auth.ts (sets cookie)
  ├─ GET /api/dashboard      → lib/cdata.ts → CData → MYOB
  └─ POST /api/chat          → Anthropic API (proxied)
```

**Security model:**
- CData credentials: server-side only (never in browser JS bundle)
- Anthropic API key: server-side only
- Portal password: httpOnly cookie, 7-day expiry
- All API routes check the auth cookie before executing

---

## Adding More Data Sources

To add a new CData connection (e.g. Google Sheets for distributor master list):

1. In CData Connect Cloud, add the connection and note the catalog name
2. Add query functions to `lib/cdata.ts`
3. Add to the `Promise.allSettled` array in `pages/api/dashboard.ts`
4. Render in `pages/index.tsx`

---

## Upgrading Auth to Google SSO (Phase 2)

Replace the password system with NextAuth.js:

```bash
npm install next-auth
```

Add to `.env.local`:
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_SECRET=...
NEXTAUTH_URL=https://portal.justautos.com.au
```

Create `pages/api/auth/[...nextauth].ts` and restrict to `@justautos.com.au` emails.

---

## File Structure

```
ja-portal/
├── lib/
│   ├── cdata.ts       ← All MYOB queries (server-side only)
│   └── auth.ts        ← Cookie auth helpers
├── pages/
│   ├── _app.tsx
│   ├── index.tsx      ← Main portal UI
│   ├── login.tsx      ← Login page
│   └── api/
│       ├── dashboard.ts   ← Fetches all MYOB data
│       ├── chat.ts        ← Proxies Claude API
│       └── auth/
│           ├── login.ts
│           └── logout.ts
├── styles/
│   └── globals.css
├── .env.example       ← Copy to .env.local
├── next.config.js
├── package.json
└── tsconfig.json
```
