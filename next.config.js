/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Increase serverless function timeout to 30s for MYOB queries
  serverRuntimeConfig: {
    maxDuration: 30,
  },
  // OAuth 2.1 endpoints for the Claude MCP connector live at the domain root
  // (Claude expects /authorize, /token, and the well-known discovery docs).
  async rewrites() {
    return [
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-authorization-server/api/mcp', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/protected-resource' },
      { source: '/authorize', destination: '/api/oauth/authorize' },
      { source: '/token', destination: '/api/oauth/token' },
      { source: '/register', destination: '/api/oauth/register' },
    ]
  },
}
module.exports = nextConfig
