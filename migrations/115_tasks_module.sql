-- 115: standalone Tasks module (Monday-style board), independent of CRM.
CREATE TABLE IF NOT EXISTS public.task_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  color       TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.task_groups (name, color, sort_order) VALUES ('Tasks', '#4f8ef7', 0) ON CONFLICT DO NOTHING;
ALTER TABLE public.task_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'todo',
  priority     TEXT NOT NULL DEFAULT 'normal',
  assignee_id  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  group_id     UUID REFERENCES public.task_groups(id) ON DELETE SET NULL,
  due_at       TIMESTAMPTZ,
  sort_order   INT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tasks_group_idx ON public.tasks(group_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON public.tasks(assignee_id) WHERE deleted_at IS NULL;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
