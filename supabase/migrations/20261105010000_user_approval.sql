-- ================================================================
-- EASY CONTROL · Approvazione utenti (come MISTER)
-- Nuovo utente si registra -> status 'pending' -> vede solo schermata
-- di attesa finche' un admin non lo approva (ed eventualmente lo
-- collega a un collega) dal pannello Configurazione.
-- Idempotente: puo' essere rieseguita senza errori.
-- ================================================================

-- ── Colonna status (backfill solo alla primissima esecuzione) ────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'status'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved'));
    -- Gli utenti gia' esistenti (creati prima di questa migrazione) sono gia' operativi
    UPDATE public.profiles SET status = 'approved';
  END IF;
END $$;

-- ── Helper: utente corrente approvato? ────────────────────────────
CREATE OR REPLACE FUNCTION public.is_approved()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND status = 'approved');
$$;

-- ── Blocca self-approvazione: solo un admin puo' cambiare status ──
CREATE OR REPLACE FUNCTION public.prevent_self_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorizzato a modificare lo stato di approvazione';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_status_change ON public.profiles;
CREATE TRIGGER trg_prevent_status_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_status_change();

-- ── RLS: un utente 'pending' non vede alcun dato operativo, solo
--        il proprio profilo (gia' coperto da profiles_read: TRUE) ──
DROP POLICY IF EXISTS "col_read"  ON public.colleagues;
CREATE POLICY "col_read"  ON public.colleagues FOR SELECT TO authenticated USING (is_approved());

DROP POLICY IF EXISTS "cfg_read"  ON public.app_config;
CREATE POLICY "cfg_read"  ON public.app_config FOR SELECT TO authenticated USING (is_approved());

DROP POLICY IF EXISTS "sf_read"  ON public.state_filters;
CREATE POLICY "sf_read"  ON public.state_filters FOR SELECT TO authenticated USING (is_approved());

DROP POLICY IF EXISTS "rep_read"  ON public.daily_reports;
CREATE POLICY "rep_read"  ON public.daily_reports FOR SELECT TO authenticated USING (is_approved());

DROP POLICY IF EXISTS "pra_read"  ON public.practices;
CREATE POLICY "pra_read"  ON public.practices FOR SELECT TO authenticated USING (is_approved());

DROP POLICY IF EXISTS "ass_read"   ON public.assignments;
CREATE POLICY "ass_read"   ON public.assignments FOR SELECT TO authenticated USING (is_approved());
DROP POLICY IF EXISTS "ass_insert" ON public.assignments;
CREATE POLICY "ass_insert" ON public.assignments FOR INSERT TO authenticated WITH CHECK (is_approved());
DROP POLICY IF EXISTS "ass_update" ON public.assignments;
CREATE POLICY "ass_update" ON public.assignments FOR UPDATE TO authenticated USING (is_approved()) WITH CHECK (is_approved());

DROP POLICY IF EXISTS "ae_read"   ON public.agent_exclusions;
CREATE POLICY "ae_read"   ON public.agent_exclusions FOR SELECT TO authenticated USING (is_approved());

DROP POLICY IF EXISTS "ps_read"  ON public.practice_status;
CREATE POLICY "ps_read"  ON public.practice_status FOR SELECT TO authenticated USING (is_approved());
DROP POLICY IF EXISTS "ps_write" ON public.practice_status;
CREATE POLICY "ps_write" ON public.practice_status FOR ALL    TO authenticated USING (is_approved()) WITH CHECK (is_approved());

DROP POLICY IF EXISTS "pn_read"   ON public.practice_notes;
CREATE POLICY "pn_read"   ON public.practice_notes FOR SELECT TO authenticated USING (is_approved());
DROP POLICY IF EXISTS "pn_insert" ON public.practice_notes;
CREATE POLICY "pn_insert" ON public.practice_notes FOR INSERT TO authenticated WITH CHECK (is_approved());

DROP POLICY IF EXISTS "chat_read"   ON public.chat_messages;
CREATE POLICY "chat_read"   ON public.chat_messages FOR SELECT TO authenticated USING (is_approved());
DROP POLICY IF EXISTS "chat_insert" ON public.chat_messages;
CREATE POLICY "chat_insert" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK (is_approved() AND author_id = auth.uid());

-- notifications resta scoped su user_id = auth.uid(), nessuna modifica necessaria
