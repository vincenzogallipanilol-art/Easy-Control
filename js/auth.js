// ================================================================
// Auth — login, logout, session management
// ================================================================
const Auth = (() => {
  let _profile = null;       // profilo "attivo" (quello impersonificato, se presente)
  let _realProfile = null;   // profilo con cui si e' effettuato l'accesso
  const IMP_KEY = 'ec_impersonate';

  function _impId() {
    try { return sessionStorage.getItem(IMP_KEY); } catch (e) { return null; }
  }
  function _setImpId(id) {
    try { if (id) sessionStorage.setItem(IMP_KEY, id); else sessionStorage.removeItem(IMP_KEY); } catch (e) { /* storage non disponibile */ }
  }

  // Carica il profilo reale e, se l'admin sta impersonificando, quello del collega
  async function _loadProfiles(userId) {
    _realProfile = await _fetchProfile(userId);
    _profile = _realProfile;
    const impId = _impId();
    if (!impId) return;
    if (_realProfile.role !== 'admin' || impId === _realProfile.id) { _setImpId(null); return; }
    try {
      const target = await _fetchProfile(impId);
      if (target.status === 'pending') throw new Error('utente non approvato');
      _profile = target;
    } catch (e) {
      _setImpId(null); // utente non piu' valido: si torna all'account principale
    }
  }

  async function signIn(email, password) {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    _setImpId(null);
    await _loadProfiles(data.user.id);
    return _profile;
  }

  async function signUp(email, password, fullName) {
    const { data, error } = await db.auth.signUp({
      email, password,
      options: { data: { full_name: fullName || '' } },
    });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    _profile = null; _realProfile = null; _setImpId(null);
    await db.auth.signOut();
  }

  async function getSession() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return null;
    if (!_profile) await _loadProfiles(session.user.id);
    return session;
  }

  function getProfile() { return _profile; }
  function getRealProfile() { return _realProfile; }
  function isImpersonating() { return !!_realProfile && !!_profile && _profile.id !== _realProfile.id; }
  // Solo un admin (account reale) puo' impersonificare un altro utente approvato
  function impersonate(userId) {
    if (_realProfile?.role !== 'admin') throw new Error('Solo un admin puo\' impersonificare');
    _setImpId(userId && userId !== _realProfile.id ? userId : null);
    history.replaceState(null, '', location.pathname + location.search);
    window.location.reload();
  }
  function stopImpersonating() {
    _setImpId(null);
    history.replaceState(null, '', location.pathname + location.search);
    window.location.reload();
  }
  function isAdmin()    { return _profile?.role === 'admin'; }
  function isTop()      { return _profile?.role === 'top'; }
  function canSeeAll()  { return _profile?.role === 'admin' || _profile?.role === 'top'; }

  async function _fetchProfile(userId) {
    const { data, error } = await db
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (error) throw error;
    return data;
  }

  // Redirect unauthenticated users
  async function requireAuth(redirectTo = 'index.html') {
    const session = await getSession();
    if (!session) {
      window.location.href = redirectTo;
      return null;
    }
    return session;
  }

  // Redirect authenticated users away from login
  async function redirectIfLoggedIn(redirectTo = 'app.html') {
    const session = await getSession();
    if (session) window.location.href = redirectTo;
  }

  return { signIn, signUp, signOut, getSession, getProfile, getRealProfile, isImpersonating, impersonate, stopImpersonating, isAdmin, isTop, canSeeAll, requireAuth, redirectIfLoggedIn };
})();
