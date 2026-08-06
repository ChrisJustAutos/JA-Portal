// pages/b2b/training/[slug].tsx
// Thin wrapper: distributor auth + B2B chrome around the shared training
// player (components/b2b/TrainingPlayer.tsx — slides → quiz → marked results).
// The admin "preview as distributor" page (/admin/b2b/training/<slug>) reuses
// the same component, so any player change lands in both places.

import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../../components/b2b/B2BLayout'
import TrainingPlayer from '../../../components/b2b/TrainingPlayer'
import { requireB2BPageAuth } from '../../../lib/b2bAuthServer'

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    preview?: boolean
    distributor: { id: string; displayName: string }
  }
}

export default function B2BTrainingCoursePage({ b2bUser }: Props) {
  const router = useRouter()
  const slug = String(router.query.slug || '')

  return (
    <B2BLayout user={b2bUser} active="training">
      <TrainingPlayer
        slug={slug}
        apiPath={`/api/b2b/training/${encodeURIComponent(slug)}`}
        backHref="/b2b/training"
        backLabel="← All courses"
        preview={!!b2bUser.preview}
      />
    </B2BLayout>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
