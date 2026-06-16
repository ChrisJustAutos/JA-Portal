// pages/api/mcp/index.ts
// JA Portal MCP server (Streamable HTTP, stateless). Staff add this URL as a
// connector in Claude Desktop / Claude Code with their personal token:
//
//   claude mcp add --transport http ja-portal https://justautos.app/api/mcp \
//     --header "Authorization: Bearer jap_xxx"
//
// Every request is authenticated by the Bearer token → portal user, and every
// tool enforces that user's portal permissions. Read-only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { resolveMcpUser, type McpUser } from '../../../lib/mcp/auth'
import { listToolsFor, callTool } from '../../../lib/mcp/tools'

export const config = { maxDuration: 60 }

const SERVER_INFO = { name: 'ja-portal', version: '1.0.0' }
const DEFAULT_PROTOCOL = '2025-06-18'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'This is an MCP Streamable HTTP endpoint — POST JSON-RPC only.' })
  }

  const user = await resolveMcpUser(req)
  if (!user) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    return res.status(401).json({ error: 'Invalid or missing token. Mint one in the portal (Settings → Claude connector).' })
  }

  let body: any
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }

  const batch = Array.isArray(body)
  const messages = batch ? body : [body]
  const out: any[] = []
  for (const m of messages) {
    const r = await handleRpc(m, user)
    if (r) out.push(r)
  }

  // Pure notifications/responses → ACK with no body (per Streamable HTTP).
  if (out.length === 0) return res.status(202).end()
  res.setHeader('Content-Type', 'application/json')
  return res.status(200).json(batch ? out : out[0])
}

async function handleRpc(m: any, user: McpUser): Promise<any | null> {
  const id = m?.id
  const method = m?.method
  const params = m?.params || {}
  const isNotification = id === undefined || id === null
  const ok = (result: any) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Read-only access to Just Autos portal data: call coaching, customers/vehicles, quotes, jobs and sales. Tools are scoped to your portal role.',
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: listToolsFor(user) })
      case 'tools/call': {
        const result = await callTool(params.name, params.arguments, user)
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      }
      default:
        return isNotification ? null : fail(-32601, `Method not found: ${method}`)
    }
  } catch (e: any) {
    // Surface tool failures as tool errors (visible to the model), not transport errors.
    if (method === 'tools/call') return ok({ content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }], isError: true })
    return isNotification ? null : fail(-32603, e?.message || String(e))
  }
}
