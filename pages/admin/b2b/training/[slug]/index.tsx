// pages/admin/b2b/training/[slug]/index.tsx — "Preview as distributor":
// the REAL shared training player (components/b2b/TrainingPlayer.tsx) inside
// admin chrome, so staff experience a course exactly as an assigned
// distributor does — slides, keyboard nav, one-question-per-screen quiz,
// submit, marked results with review. The only differences: it hits the admin
// player endpoint (works for disabled/unassigned modules; marks the quiz but
// NEVER records an attempt or pings the staff bell) and keeps its own
// localStorage resume key so it can't clobber a real distributor session.
// The static answer sheet lives at /admin/b2b/training/<slug>/answers.

import { useRouter } from 'next/router'
import PortalTopBar from '../../../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../../../components/b2b/B2BAdminTabs'
import TrainingPlayer from '../../../../../components/b2b/TrainingPlayer'
import { requirePageAuth } from '../../../../../lib/authServer'
import { T, alpha } from '../../../../../lib/ui/theme'

export default function AdminTrainingPreview({ user }: { user: any }) {
  const router = useRouter()
  const slug = typeof router.query.slug === 'string' ? router.query.slug : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
      <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
      <main className="b2b-admin-main" style={{ flex: 1, padding: '28px 32px', width: '100%', boxSizing: 'border-box' }}>
        <B2BAdminTabs active="training" />
        {slug && (
          <TrainingPlayer
            slug={slug}
            apiPath={`/api/b2b/admin/training/${encodeURIComponent(slug)}/player`}
            backHref="/admin/b2b/training"
            backLabel="← Training assignments"
            storagePrefix="admin-preview"
            titleSuffix=" — preview · Just Autos"
            banner={
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                background: alpha(T.amber, '14'), border: `1px solid ${alpha(T.amber, '45')}`,
                borderRadius: 8, padding: '8px 12px', fontSize: 12,
              }}>
                <span style={{ flex: 1, minWidth: 240, color: T.amber, fontWeight: 600 }}>
                  Admin preview — exactly what an assigned distributor sees. Quiz attempts here are not recorded.
                </span>
                <a href={`/admin/b2b/training/${encodeURIComponent(slug)}/answers`}
                  style={{ color: T.blue, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                  Answer sheet →
                </a>
              </div>
            }
          />
        )}
      </main>
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
