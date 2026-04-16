// pages/login.tsx
import { useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { GetServerSideProps } from 'next'

export const getServerSideProps: GetServerSideProps = async (context) => {
  const cookie = context.req.cookies['ja_portal_auth']
  const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || 'justautos2026'
  if (cookie) {
    try {
      const decoded = Buffer.from(cookie, 'base64').toString('utf8')
      if (decoded === PORTAL_PASSWORD) {
        return { redirect: { destination: '/', permanent: false } }
      }
    } catch {}
  }
  return { props: {} }
}

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      })
      if (res.ok) {
        router.push('/')
      } else {
        setError('Incorrect password')
        setLoading(false)
      }
    } catch {
      setError('Connection error — try again')
      setLoading(false)
    }
  }

  return (
    <>
      <Head><title>Just Autos — Portal Login</title></Head>
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: '#0d0f12', fontFamily: "'DM Sans',system-ui,sans-serif",
      }}>
        <div style={{
          background: '#131519', border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 14, padding: '40px 36px', width: 360,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10, background: '#4f8ef7',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, fontWeight: 600, color: '#fff',
            }}>JA</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#e8eaf0' }}>Just Autos</div>
              <div style={{ fontSize: 12, color: '#545968' }}>Management Portal</div>
            </div>
          </div>

          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: '#545968', display: 'block', marginBottom: 6 }}>
                Portal Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                autoFocus
                style={{
                  width: '100%', background: '#1a1d23', border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: 8, padding: '10px 12px', fontSize: 14, color: '#e8eaf0',
                  outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
                }}
              />
            </div>

            {error && (
              <div style={{ fontSize: 12, color: '#f04e4e', marginBottom: 12 }}>{error}</div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              style={{
                width: '100%', background: loading || !password ? '#21252d' : '#4f8ef7',
                border: 'none', borderRadius: 8, padding: '10px 0',
                fontSize: 14, fontWeight: 500, color: '#fff',
                cursor: loading || !password ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div style={{ marginTop: 20, fontSize: 11, color: '#545968', textAlign: 'center' }}>
            Contact Chris to get access
          </div>
        </div>
      </div>
    </>
  )
}
