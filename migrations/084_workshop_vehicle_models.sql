-- ═══════════════════════════════════════════════════════════════════
-- 084_workshop_vehicle_models.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- Vehicle models for the workshop: a managed list (e.g. 200 Series, 79 Series,
-- 300 Series, Prado, Hilux). Job types are tagged with the model(s) they apply
-- to (M2M), and each customer vehicle is tagged with its model — so the diary
-- booking popup only offers the job types relevant to that vehicle.
-- RLS enabled, service-role only.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_vehicle_models (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workshop_vehicle_models_name_idx ON public.workshop_vehicle_models (name);

-- Job type ↔ model (many-to-many).
CREATE TABLE IF NOT EXISTS public.workshop_job_type_models (
  job_type_id UUID NOT NULL REFERENCES public.workshop_job_types(id) ON DELETE CASCADE,
  model_id    UUID NOT NULL REFERENCES public.workshop_vehicle_models(id) ON DELETE CASCADE,
  PRIMARY KEY (job_type_id, model_id)
);
CREATE INDEX IF NOT EXISTS workshop_job_type_models_model_idx ON public.workshop_job_type_models (model_id);

-- Tag each customer vehicle with its model.
ALTER TABLE public.workshop_vehicles ADD COLUMN IF NOT EXISTS model_id UUID REFERENCES public.workshop_vehicle_models(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS workshop_vehicle_models_set_updated ON public.workshop_vehicle_models;
CREATE TRIGGER workshop_vehicle_models_set_updated BEFORE UPDATE ON public.workshop_vehicle_models
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

ALTER TABLE public.workshop_vehicle_models   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_job_type_models  ENABLE ROW LEVEL SECURITY;
