-- ================================================================
-- EASY CONTROL · Schema Supabase
-- Incolla tutto nel SQL Editor del tuo progetto Supabase
-- ================================================================

-- ── PROFILES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id        UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email     TEXT NOT NULL,
  full_name TEXT DEFAULT '',
  role      TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-crea profile al primo login
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── COLLEAGUES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.colleagues (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  active              BOOLEAN DEFAULT TRUE,
  min_quota           INTEGER DEFAULT 30,
  max_quota           INTEGER DEFAULT 60,
  primary_tipologie   TEXT[] DEFAULT '{}',
  secondary_tipologie TEXT[] DEFAULT '{}',
  color_idx           INTEGER DEFAULT 0,
  sort_order          INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Default colleghi
INSERT INTO public.colleagues (id, name, min_quota, max_quota, primary_tipologie, secondary_tipologie, color_idx, sort_order) VALUES
  ('c1','Ganguli',   40,  60,  ARRAY['finanziamento impresa','leasing','fideiussione','altro strumento finanziario','altro strumento finanziario 2'], ARRAY[]::TEXT[], 0, 0),
  ('c2','Milly',     40,  60,  ARRAY['prestito personale','prestito vitalizio','prestito finalizzato'], ARRAY[]::TEXT[], 1, 1),
  ('c3','Alessandro',50, 120,  ARRAY['mutuo immobile'], ARRAY['cessione del quinto'], 2, 2)
ON CONFLICT (id) DO NOTHING;

-- ── APP CONFIG ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES public.profiles(id)
);

INSERT INTO public.app_config (key, value) VALUES ('working_days','1')
ON CONFLICT (key) DO NOTHING;

-- ── STATE FILTERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.state_filters (
  stato      TEXT PRIMARY KEY,
  included   BOOLEAN DEFAULT TRUE,
  note_mode  TEXT DEFAULT 'empty' CHECK (note_mode IN ('any','empty','filled')),
  conf_mode  TEXT DEFAULT 'empty' CHECK (conf_mode IN ('any','empty','filled')),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.state_filters (stato) VALUES
  ('Stipulata-6'),('Liquidata'),('Pagata'),
  ('Attesa Stipula-5'),('Benestare acquisito'),('In attesa benestare'),('In attesa lettera di priorità'),
  ('Deliberata-4'),('Deliberata'),('Deliberata - non perfezionata')
ON CONFLICT (stato) DO NOTHING;

-- ── DAILY REPORTS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_reports (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  report_date DATE DEFAULT CURRENT_DATE,
  filename    TEXT,
  uploaded_by UUID REFERENCES public.profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  row_count   INTEGER DEFAULT 0,
  active      BOOLEAN DEFAULT FALSE
);

-- ── PRACTICES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.practices (
  id                       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  report_id                UUID REFERENCES public.daily_reports(id) ON DELETE CASCADE,
  pratica_id               TEXT DEFAULT '',
  cognome                  TEXT DEFAULT '',
  nome                     TEXT DEFAULT '',
  note                     TEXT DEFAULT '',
  tipologia                TEXT DEFAULT '',
  istituto_finanziario     TEXT DEFAULT '',
  agente_attuale           TEXT DEFAULT '',
  area_manager             TEXT DEFAULT '',
  group_manager            TEXT DEFAULT '',
  team_manager             TEXT DEFAULT '',
  stato_attuale            TEXT DEFAULT '',
  conformita_documentazione TEXT DEFAULT '',
  originale_archiviato     TEXT DEFAULT '',
  pratica_fea              TEXT DEFAULT '',
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS practices_report_idx   ON public.practices(report_id);
CREATE INDEX IF NOT EXISTS practices_stato_idx    ON public.practices(stato_attuale);
CREATE INDEX IF NOT EXISTS practices_tipologia_idx ON public.practices(tipologia);

-- ── ASSIGNMENTS (REAL-TIME) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assignments (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  practice_id  UUID REFERENCES public.practices(id) ON DELETE CASCADE UNIQUE,
  report_id    UUID REFERENCES public.daily_reports(id) ON DELETE CASCADE,
  colleague_id TEXT REFERENCES public.colleagues(id) ON DELETE SET NULL,
  assigned_by  UUID REFERENCES public.profiles(id),
  assigned_at  TIMESTAMPTZ DEFAULT NOW(),
  is_manual    BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS assignments_report_idx    ON public.assignments(report_id);
CREATE INDEX IF NOT EXISTS assignments_colleague_idx ON public.assignments(colleague_id);

-- REPLICA IDENTITY per real-time completo
ALTER TABLE public.assignments   REPLICA IDENTITY FULL;
ALTER TABLE public.daily_reports REPLICA IDENTITY FULL;
ALTER TABLE public.colleagues    REPLICA IDENTITY FULL;
ALTER TABLE public.state_filters REPLICA IDENTITY FULL;
ALTER TABLE public.app_config    REPLICA IDENTITY FULL;

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.colleagues    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.state_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.practices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments   ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;

-- profiles
CREATE POLICY "profiles_read"   ON public.profiles FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "profiles_write"  ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid() OR is_admin()) WITH CHECK (id = auth.uid() OR is_admin());

-- colleagues
CREATE POLICY "col_read"   ON public.colleagues FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "col_insert" ON public.colleagues FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "col_update" ON public.colleagues FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "col_delete" ON public.colleagues FOR DELETE TO authenticated USING (is_admin());

-- app_config
CREATE POLICY "cfg_read"  ON public.app_config FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "cfg_write" ON public.app_config FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- state_filters
CREATE POLICY "sf_read"  ON public.state_filters FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "sf_write" ON public.state_filters FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- daily_reports
CREATE POLICY "rep_read"  ON public.daily_reports FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "rep_write" ON public.daily_reports FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- practices
CREATE POLICY "pra_read"  ON public.practices FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "pra_write" ON public.practices FOR ALL    TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- assignments: tutti leggono, tutti scrivono (assegnazioni manuali), admin può tutto
CREATE POLICY "ass_read"   ON public.assignments FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "ass_insert" ON public.assignments FOR INSERT TO authenticated WITH CHECK (TRUE);
CREATE POLICY "ass_update" ON public.assignments FOR UPDATE TO authenticated USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "ass_delete" ON public.assignments FOR DELETE TO authenticated USING (is_manual = TRUE OR is_admin());

-- ── AGENT EXCLUSIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_exclusions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.agent_exclusions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ae_read"   ON public.agent_exclusions FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "ae_insert" ON public.agent_exclusions FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "ae_delete" ON public.agent_exclusions FOR DELETE TO authenticated USING (is_admin());

ALTER TABLE public.agent_exclusions REPLICA IDENTITY FULL;

-- ── SECURITY FIX: blocca self-escalation del ruolo ───────────────
-- La policy "profiles_write" permette a un utente di modificare la propria
-- riga (id = auth.uid()), ma senza controllo a livello di colonna questo
-- consente a QUALSIASI utente autenticato di settare il proprio role='admin'
-- con una chiamata REST diretta (bypassando la UI). Questo trigger blocca
-- il cambio di 'role' a meno che chi esegue l'update sia già admin.
CREATE OR REPLACE FUNCTION public.prevent_self_role_escalation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorizzato a modificare il ruolo';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_role_escalation ON public.profiles;
CREATE TRIGGER trg_prevent_role_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_role_escalation();

-- ── REALTIME PUBLICATIONS ────────────────────────────────────────
-- In Supabase dashboard → Database → Replication → enable per le tabelle:
-- assignments, daily_reports, colleagues, state_filters, app_config, agent_exclusions
