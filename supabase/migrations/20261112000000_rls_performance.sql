-- ================================================================
-- Prestazioni RLS: le funzioni is_approved()/can_see_all()/auth.uid()
-- nelle policy venivano rivalutate per OGNI riga letta (migliaia di
-- righe = migliaia di lookup su profiles). Avvolte in (SELECT ...)
-- il planner le calcola una sola volta per query.
-- Stessa logica di accesso di prima: cambia solo la velocita'.
-- Idempotente.
-- ================================================================

DROP POLICY IF EXISTS "pra_read" ON public.practices;
CREATE POLICY "pra_read" ON public.practices FOR SELECT TO authenticated USING (
  (SELECT is_approved()) AND (
    (SELECT can_see_all()) OR
    practices.id IN (
      SELECT a.practice_id FROM public.assignments a
      WHERE a.colleague_id = (SELECT p.colleague_id FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    )
  )
);

DROP POLICY IF EXISTS "ass_read" ON public.assignments;
CREATE POLICY "ass_read" ON public.assignments FOR SELECT TO authenticated USING (
  (SELECT is_approved()) AND (
    (SELECT can_see_all()) OR
    colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = (SELECT auth.uid()))
  )
);

DROP POLICY IF EXISTS "pw_read" ON public.practice_work;
CREATE POLICY "pw_read" ON public.practice_work FOR SELECT TO authenticated USING (
  (SELECT is_approved()) AND (
    (SELECT can_see_all())
    OR set_by = (SELECT auth.uid())
    OR colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = (SELECT auth.uid()))
  )
);

DROP POLICY IF EXISTS "pw_update" ON public.practice_work;
CREATE POLICY "pw_update" ON public.practice_work FOR UPDATE TO authenticated USING (
  (SELECT is_approved()) AND (
    (SELECT can_see_all())
    OR colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = (SELECT auth.uid()))
  )
) WITH CHECK ((SELECT is_approved()));

DROP POLICY IF EXISTS "pc_read" ON public.practice_checks;
CREATE POLICY "pc_read" ON public.practice_checks FOR SELECT TO authenticated USING (
  (SELECT is_approved()) AND (
    (SELECT can_see_all())
    OR user_id = (SELECT auth.uid())
    OR colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = (SELECT auth.uid()))
  )
);

-- Lettura a pagine ordinate per id (caricamento di report con migliaia di pratiche)
CREATE INDEX IF NOT EXISTS practices_report_id_idx   ON public.practices(report_id, id);
CREATE INDEX IF NOT EXISTS assignments_report_id_idx ON public.assignments(report_id, id);
