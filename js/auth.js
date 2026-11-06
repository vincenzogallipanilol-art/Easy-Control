// ================================================================
// Auth — login, logout, session management
// ================================================================
const Auth = (() => {
  let _profile = null;

  async function signIn(email, password) {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    _profile = await _fetchProfile(data.user.id);
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
    _profile = null;
    await db.auth.signOut();
  }

  async function getSession() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return null;
    if (!_profile) _profile = await _fetchProfile(session.user.id);
    return session;
  }

  function getProfile() { return _profile; }
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

  return { signIn, signUp, signOut, getSession, getProfile, isAdmin, isTop, canSeeAll, requireAuth, redirectIfLoggedIn };
})();
