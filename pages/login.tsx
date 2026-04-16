// pages/login.tsx
import { useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      router.push('/')
    } else {
      setError('Incorrect password')
      setLoading(false)
    }
  }

  return (
    <>
      <Head><title>Just Autos — Portal Login</title></Head>
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'var(--bg)',
      }}>
        <div style={{
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 14, padding: '40px 36px', width: 360,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10, background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, fontWeight: 600, color: '#fff',
            }}>JA</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>Just Autos</div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Management Portal</div>
            </div>
          </div>

          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 6 }}>
                Portal Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                autoFocus
                style={{
                  width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: '10px 12px', fontSize: 14, color: 'var(--text)',
                  outline: 'none', fontFamily: 'var(--font)',
                }}
              />
            </div>

            {error && (
              <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{error}</div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              style={{
                width: '100%', background: loading ? 'var(--bg4)' : 'var(--accent)',
                border: 'none', borderRadius: 8, padding: '10px 0',
                fontSize: 14, fontWeight: 500, color: '#fff', cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font)',
              }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div style={{ marginTop: 20, fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
            Contact Chris or Matt to get access
          </div>
        </div>
      </div>
    </>
  )
}
