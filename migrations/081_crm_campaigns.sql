-- ═══════════════════════════════════════════════════════════════════
-- 081_crm_campaigns.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- CRM Phase 3 — campaigns + segments (the marketing half of ActiveCampaign).
-- Build an audience (segment), compose a broadcast, send in batches via Resend,
-- track opens/clicks, and honour unsubscribes.
--
--   crm_segments              — saved audience filter definitions
--   crm_campaigns             — a broadcast (draft → scheduled → sending → sent)
--   crm_campaign_recipients   — one row per recipient, with a tracking token
--   crm_email_events          — open / click / unsubscribe / bounce / complaint log
--
-- Adds crm_contacts.marketing_opt_out — separate from do_not_contact so a
-- marketing unsubscribe doesn't kill transactional follow-ups (and vice-versa).
-- Campaign audiences exclude BOTH flags + require an email. RLS: service-role only.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.crm_contacts ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false;

-- ── Segments ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_segments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  definition  JSONB NOT NULL DEFAULT '{}',  -- {tags_any[],sources[],owner_ids[],created_after,created_before,search}
  created_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

-- ── Campaigns ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  preheader       TEXT,
  body            TEXT NOT NULL DEFAULT '',   -- author's text/HTML with {{vars}}
  from_name       TEXT,
  reply_to        TEXT,
  segment_id      UUID REFERENCES public.crm_segments(id) ON DELETE SET NULL,
  audience_all    BOOLEAN NOT NULL DEFAULT false,  -- ignore segment, target all mailable contacts
  status          TEXT NOT NULL DEFAULT 'draft',   -- draft|scheduled|sending|sent|cancelled
  scheduled_at    TIMESTAMPTZ,
  total_recipients INT NOT NULL DEFAULT 0,
  sent_count      INT NOT NULL DEFAULT 0,
  fail_count      INT NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ,
  created_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_campaigns_status_idx ON public.crm_campaigns (status);

-- ── Recipients ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_campaign_recipients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES public.crm_campaigns(id) ON DELETE CASCADE,
  contact_id    UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  email         TEXT NOT NULL,
  token         TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|failed|bounced|complained
  provider_id   TEXT,                             -- Resend email id
  open_count    INT NOT NULL DEFAULT 0,
  click_count   INT NOT NULL DEFAULT 0,
  opened_at     TIMESTAMPTZ,
  first_clicked_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  error         TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_camp_recip_unique ON public.crm_campaign_recipients (campaign_id, contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS crm_camp_recip_token_idx ON public.crm_campaign_recipients (token);
CREATE INDEX IF NOT EXISTS crm_camp_recip_camp_idx ON public.crm_campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS crm_camp_recip_provider_idx ON public.crm_campaign_recipients (provider_id);

-- ── Email events ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_email_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  UUID REFERENCES public.crm_campaign_recipients(id) ON DELETE CASCADE,
  campaign_id   UUID REFERENCES public.crm_campaigns(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,   -- open|click|unsubscribe|bounce|complaint|delivered
  url           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_email_events_camp_idx ON public.crm_email_events (campaign_id, type);

-- ── updated_at triggers ──────────────────────────────────────────────
DROP TRIGGER IF EXISTS crm_segments_set_updated ON public.crm_segments;
CREATE TRIGGER crm_segments_set_updated BEFORE UPDATE ON public.crm_segments
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();
DROP TRIGGER IF EXISTS crm_campaigns_set_updated ON public.crm_campaigns;
CREATE TRIGGER crm_campaigns_set_updated BEFORE UPDATE ON public.crm_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

-- ── RLS: service-role only ────────────────────────────────────────────
ALTER TABLE public.crm_segments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_campaigns           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_email_events        ENABLE ROW LEVEL SECURITY;
