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

  return { signIn, signOut, getSession, getProfile, isAdmin, requireAuth, redirectIfLoggedIn };
})();
