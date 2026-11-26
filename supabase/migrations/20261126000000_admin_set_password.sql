-- L'admin imposta la password di un utente (per farlo accedere)
CREATE OR REPLACE FUNCTION public.admin_set_password(target_user UUID, new_password TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, auth
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo un admin puo'' impostare una password';
  END IF;
  IF length(coalesce(new_password, '')) < 6 THEN
    RAISE EXCEPTION 'La password deve avere almeno 6 caratteri';
  END IF;
  UPDATE auth.users
     SET encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   WHERE id = target_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Utente non trovato';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_password(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_password(UUID, TEXT) TO authenticated;
