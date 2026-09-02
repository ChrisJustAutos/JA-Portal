// Stable per-deploy build id, baked into the client bundle as
// NEXT_PUBLIC_BUILD_ID and also returned at runtime by /api/version. The
// UpdateNotifier compares the two to detect when a new version has shipped.
// On Vercel the commit SHA changes every deploy; locally it falls back to 'dev'.
const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  'dev'

// Which Workshop sections are switched on (MechanicDesk stays the workshop
// system of record) — the same list the tab strip reads.
const { parkedWorkshopRewrites } = require('./lib/workshop-sections')
const { parkedB2BRewrites } = require('./lib/b2b-sections')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
  // Increase serverless function timeout to 30s for MYOB queries
  serverRuntimeConfig: {
    maxDuration: 30,
  },
  // The admin Library (/admin/library) reads docs/*.md and docs/*.pdf off disk
  // at request time. Next's dependency tracer can't see those reads because the
  // paths are built at runtime from lib/library-docs.ts, so the files would be
  // left out of the serverless bundle and 404 in production while working fine
  // locally. Force them in.
  experimental: {
    outputFileTracingIncludes: {
      '/admin/library': ['./docs/**'],
      '/admin/library/[slug]': ['./docs/**'],
      '/api/admin/library/[slug]': ['./docs/**'],
    },
  },
  // OAuth 2.1 endpoints for the Claude MCP connector live at the domain root
  // (Claude expects /authorize, /token, and the well-known discovery docs).
  // The AI-narrative report builder that used to live at /reports was removed
  // (Chris, 2026-09-02). Redirect rather than 404: the sidebar, saved links and
  // anything still pointing at the module root all land on the first real tab.
  // Temporary, so it costs nothing to put a page back here later.
  async redirects() {
    return [
      { source: '/reports', destination: '/reports/sales-report', permanent: false },
      // The Distributor Map became a view inside the Workshop Map (2026-09-02).
      // Carry the view through so the weekly recap email's "full map" link and
      // anyone's bookmark still open the distributor view, not Jobs.
      { source: '/reports/distributor-map', destination: '/reports/map?view=dist', permanent: false },
    ]
  },
  async rewrites() {
    // beforeFiles so the parked-Workshop rewrites win over the real page files
    // (an array return, or afterFiles, is checked AFTER the filesystem and the
    // parked pages would render instead of the notice). The OAuth rewrites keep
    // their original afterFiles behaviour.
    return {
      beforeFiles: [...parkedWorkshopRewrites(), ...parkedB2BRewrites()],
      afterFiles: [
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-authorization-server/api/mcp', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/protected-resource' },
      { source: '/authorize', destination: '/api/oauth/authorize' },
      { source: '/token', destination: '/api/oauth/token' },
      { source: '/register', destination: '/api/oauth/register' },
      ],
    }
  },
}
module.exports = nextConfig
