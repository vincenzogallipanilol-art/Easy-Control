-- ================================================================
-- EASY CONTROL · Note, stato pratica, notifiche, chat
-- Idempotente: puo' essere rieseguita senza errori.
-- ================================================================

-- ── Collega profilo utente ↔ collega (serve per "Le mie pratiche") ──
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS colleague_id TEXT REFERENCES public.colleagues(id) ON DELETE SET NULL;

-- ── STATO PRATICA (chiave = pratica_id, sopravvive al reload CSV) ──
CREATE TABLE IF NOT EXISTS public.practice_status (
  pratica_id  TEXT PRIMARY KEY,
  color       TEXT NOT NULL CHECK (color IN ('verde','giallo','arancione','rosso','viola','azzurro')),
  updated_by  UUID REFERENCES public.profiles(id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.practice_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ps_read"  ON public.practice_status;
CREATE POLICY "ps_read"  ON public.practice_status FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "ps_write" ON public.practice_status;
CREATE POLICY "ps_write" ON public.practice_status FOR ALL    TO authenticated USING (TRUE) WITH CHECK (TRUE);
ALTER TABLE public.practice_status REPLICA IDENTITY FULL;

-- ── NOTE (log/thread per pratica_id, append-only) ────────────────
CREATE TABLE IF NOT EXISTS public.practice_notes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pratica_id  TEXT NOT NULL,
  author_id   UUID REFERENCES public.profiles(id),
  body        TEXT NOT NULL DEFAULT '',
  color       TEXT CHECK (color IN ('verde','giallo','arancione','rosso','viola','azzurro')),
  mentions    UUID[] DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS practice_notes_pratica_idx ON public.practice_notes(pratica_id);
ALTER TABLE public.practice_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pn_read"   ON public.practice_notes;
CREATE POLICY "pn_read"   ON public.practice_notes FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "pn_insert" ON public.practice_notes;
CREATE POLICY "pn_insert" ON public.practice_notes FOR INSERT TO authenticated WITH CHECK (TRUE);
ALTER TABLE public.practice_notes REPLICA IDENTITY FULL;

-- ── NOTIFICHE (tag su una nota) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'mention',
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT DEFAULT '',
  pratica_id  TEXT,
  read        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON public.notifications(user_id);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notif_read"   ON public.notifications;
CREATE POLICY "notif_read"   ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "notif_insert" ON public.notifications;
CREATE POLICY "notif_insert" ON public.notifications FOR INSERT TO authenticated WITH CHECK (TRUE);
DROP POLICY IF EXISTS "notif_update" ON public.notifications;
CREATE POLICY "notif_update" ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

-- ── CHAT (stanza unica di gruppo) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  author_id   UUID REFERENCES public.profiles(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_read"   ON public.chat_messages;
CREATE POLICY "chat_read"   ON public.chat_messages FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "chat_insert" ON public.chat_messages;
CREATE POLICY "chat_insert" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());
ALTER TABLE public.chat_messages REPLICA IDENTITY FULL;

-- ── REALTIME ───────────────────────────────────────────────────────
-- Verifica in Database → Replication che risultino abilitate anche:
-- practice_status, practice_notes, notifications, chat_messages
