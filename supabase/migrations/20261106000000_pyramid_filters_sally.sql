-- ================================================================
-- EASY CONTROL · Sistema piramidale (Admin/Top/User), filtri stato
-- per collega, pool "Agenti Sally" agganciabile.
-- Idempotente: puo' essere rieseguita senza errori.
-- ================================================================

-- ── 1. Ruolo "top" ──────────────────────────── --
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('admin','top','user'));

-- ── 2. Helper: l'utente corrente vede tutto? (admin o top) ──── --
CREATE OR REPLACE FUNCTION public.can_see_all()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','top'));
$$;

-- ── 3. RLS piramidale: practices/assignments ─────────── --
-- Admin e Top vedono tutto. Un 'user' vede SOLO le pratiche/assegnazioni
-- del collega a cui e' collegato il suo profilo (profiles.colleague_id).
DROP POLICY IF EXISTS "pra_read" ON public.practices;
CREATE POLICY "pra_read" ON public.practices FOR SELECT TO authenticated USING (
  is_approved() AND (
    can_see_all() OR
    EXISTS (
      SELECT 1 FROM public.assignments a
      JOIN public.profiles p ON p.id = auth.uid()
      WHERE a.practice_id = practices.id AND a.colleague_id = p.colleague_id
    )
  )
);

DROP POLICY IF EXISTS "ass_read" ON public.assignments;
CREATE POLICY "ass_read" ON public.assignments FOR SELECT TO authenticated USING (
  is_approved() AND (
    can_see_all() OR
    colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = auth.uid())
  )
);

-- ── 4. FILTRI STATO PER COLLEGA (sostituisce il filtro globale) ─── --
CREATE TABLE IF NOT EXISTS public.colleague_state_filters (
  colleague_id TEXT NOT NULL REFERENCES public.colleagues(id) ON DELETE CASCADE,
  stato        TEXT NOT NULL,
  included     BOOLEAN DEFAULT TRUE,
  note_mode    TEXT DEFAULT 'empty' CHECK (note_mode IN ('any','empty','filled')),
  conf_mode    TEXT DEFAULT 'empty' CHECK (conf_mode IN ('any','empty','filled')),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (colleague_id, stato)
);

ALTER TABLE public.colleague_state_filters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "csf_read"  ON public.colleague_state_filters;
CREATE POLICY "csf_read"  ON public.colleague_state_filters FOR SELECT TO authenticated USING (is_approved());
DROP POLICY IF EXISTS "csf_write" ON public.colleague_state_filters;
CREATE POLICY "csf_write" ON public.colleague_state_filters FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());

ALTER TABLE public.colleague_state_filters REPLICA IDENTITY FULL;

-- Backfill: ogni collega esistente parte con gli stessi filtri che
-- aveva il vecchio filtro globale (una tantum, non sovrascrive se già presente)
INSERT INTO public.colleague_state_filters (colleague_id, stato, included, note_mode, conf_mode)
SELECT c.id, sf.stato, sf.included, sf.note_mode, sf.conf_mode
FROM public.colleagues c
CROSS JOIN public.state_filters sf
ON CONFLICT (colleague_id, stato) DO NOTHING;

-- ── 5. Pool "Agenti Sally": aggancio a un collega ───────── --
INSERT INTO public.app_config (key, value) VALUES ('sally_hook_colleague_id', 'null'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── REALTIME ──────────────────────────────── --
-- Verifica in Database → Replication che risulti abilitata anche:
-- colleague_state_filters
