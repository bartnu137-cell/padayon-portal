/*
  PADAYON PORTAL
  - Quiz engine (built-in database.js)
  - Admin Content Manager (library.json)
  - Notes/PDF viewer

  IMPORTANT:
  This is a static site. Admin cannot push to GitHub automatically.
  To share to friends: export library.json in Admin > Backup and commit it.
*/

// =========================
// Accounts
// =========================
const ACCOUNTS = [
  { username: 'admin', password: 'admin', role: 'admin' },
  { username: 'saligao', password: 'carl', role: 'user' },
  { username: 'ramos', password: 'carl', role: 'user' },
  { username: 'fernandez', password: 'cristopher', role: 'user' },
  { username: 'cortez', password: 'cyron', role: 'user' },
  { username: 'castillo', password: 'gian', role: 'user' },
  { username: 'maceda', password: 'mj', role: 'user' },
  { username: 'quillopo', password: 'pj', role: 'user' },
  { username: 'arcenas', password: 'rheygie', role: 'user' },
  { username: 'felizarta', password: 'treb', role: 'user' },
];

let session = {
  username: null,
  role: null, // 'admin' | 'user'
};

let activeMenu = 'submenu-taypi'; // back target for quiz

// =========================
// Library (shared content)
// =========================
const LIBRARY_FILENAME = 'library.json';
const LIBRARY_JS_FILENAME = 'library.js';
const LIBRARY_CACHE_KEY = 'padayon_library_cache_v2';
const LIBRARY_GLOBAL_VAR = 'PADAYON_LIBRARY';

// Cross-tab live sync (admin uploads -> user view updates instantly in another tab)
const LIBRARY_SYNC_CHANNEL = 'padayon_library_sync_v1';
let librarySyncChannel = null;
let librarySyncInitialized = false;
let lastAppliedLibraryUpdatedAtMs = 0;

// =========================
// Live Backend (Render)
// - Online users (presence)
// - Live activity tracking (what screen users are on)
// - Live library sync (admin edits instantly appear on clients)
// =========================
const LIVE_BACKEND_URL_KEY = 'padayon_backend_url';
const LIVE_TOKEN_KEY = 'padayon_auth_token_v1';

let liveBackendUrl = '';
let liveAuthToken = '';
let liveWs = null;
let liveWsConnected = false;
let liveReconnectTimer = null;
let liveReconnectDelayMs = 1000;
let liveClientId = null;

let liveOnlinePublic = []; // [{ username, role }]
let liveOnlineAdmin = [];  // [{ username, role, activity, path, view, connectedAt, lastSeen, clientId }]
let liveAdminLog = [];     // [{ ts, username, message }]
let liveLastPresenceHash = '';
let liveLibraryPushTimer = null;
let liveLastLibraryPushedAtMs = 0;
let liveMyScoreHistory = [];
let currentQuizMeta = { id: null, title: '', folder: '', source: 'built_in' };
let adminEditingQuestionIndex = -1;

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function getConfiguredBackendUrl() {
  // Priority: localStorage (admin can change without editing index.html), then window.PADAYON_BACKEND_URL.
  let url = '';

  try {
    url = trimSlash(localStorage.getItem(LIVE_BACKEND_URL_KEY) || '');
  } catch (_) {
    url = '';
  }

  if (!url) {
    try {
      url = trimSlash(window.PADAYON_BACKEND_URL || '');
    } catch (_) {
      url = '';
    }
  }

  // If user typed a domain without protocol, assume https.
  if (url && !/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  // Persist config into localStorage so you don't lose it.
  try {
    if (url) localStorage.setItem(LIVE_BACKEND_URL_KEY, url);
  } catch (_) {}

  return url;
}

function setConfiguredBackendUrl(url) {
  let clean = trimSlash(url);
  if (clean && !/^https?:\/\//i.test(clean)) clean = 'https://' + clean;

  try {
    if (clean) localStorage.setItem(LIVE_BACKEND_URL_KEY, clean);
    else localStorage.removeItem(LIVE_BACKEND_URL_KEY);
  } catch (_) {}

  liveBackendUrl = clean;
  updateLiveStatusUI();
}

// --- Admin UI: Backend URL (stored in localStorage) ---
function adminRefreshBackendUrlUI() {
  const inp = document.getElementById('admin-backend-url-input');
  const status = document.getElementById('admin-backend-url-status');

  const url = getConfiguredBackendUrl();

  // Avoid overwriting while typing
  if (inp && document.activeElement !== inp) {
    inp.value = url || '';
  }

  if (status) {
    status.textContent = 'Current: ' + (url || '(not set)');
  }
}

async function liveReloginFromRememberIfPossible() {
  if (!liveIsEnabled()) return { ok: false, reason: 'no_backend' };
  if (!session?.username) return { ok: false, reason: 'no_session' };
  if (liveAuthToken) return { ok: true, reason: 'has_token' };

  // re-login without captcha is no longer allowed
  return { ok: false, reason: 'captcha_required' };
}


async function adminSaveBackendUrlFromUI() {
  const inp = document.getElementById('admin-backend-url-input');
  if (!inp) return;

  const prev = trimSlash(liveBackendUrl);
  const nextRaw = String(inp.value || '').trim();

  setConfiguredBackendUrl(nextRaw);
  liveBackendUrl = getConfiguredBackendUrl();

  const next = trimSlash(liveBackendUrl);

  // If backend changed, clear token so we don't send a token for the wrong server.
  if (prev !== next) {
    setLiveToken('');
  }

  // Reconnect live presence
  try { liveDisconnect(); } catch (_) {}

  // Attempt to re-auth using Remember Me (optional)
  try {
    if (session?.username && liveIsEnabled()) {
      liveAuthToken = getLiveToken();
      await liveReloginFromRememberIfPossible();
      liveAuthToken = getLiveToken();
      liveConnect();
      // Pull latest library immediately
      loadLibraryFromBackend();
    }
  } catch (_) {
    // ignore
  }

  adminRefreshBackendUrlUI();
}

function adminClearBackendUrlFromUI() {
  setConfiguredBackendUrl('');
  setLiveToken('');

  try { liveDisconnect(); } catch (_) {}

  // Reset UI state
  try {
    liveOnlinePublic = [];
    liveOnlineAdmin = [];
    renderOnlineUsersWidget();
    renderAdminOnlineUsers();
    renderAdminLog();
    updateLiveStatusUI();
  } catch (_) {}

  adminRefreshBackendUrlUI();
}

function getLiveToken() {
  try {
    return String(localStorage.getItem(LIVE_TOKEN_KEY) || '').trim();
  } catch (_) {
    return '';
  }
}

function setLiveToken(token) {
  const t = String(token || '').trim();
  try {
    if (t) localStorage.setItem(LIVE_TOKEN_KEY, t);
    else localStorage.removeItem(LIVE_TOKEN_KEY);
  } catch (_) {}
  liveAuthToken = t;
}

function httpToWsUrl(httpUrl) {
  const u = String(httpUrl || '').trim();
  if (!u) return '';
  if (u.startsWith('https://')) return 'wss://' + u.slice('https://'.length);
  if (u.startsWith('http://')) return 'ws://' + u.slice('http://'.length);
  // Default: assume https
  return 'wss://' + u.replace(/^wss?:\/\//, '');
}

function liveIsEnabled() {
  return !!(liveBackendUrl && liveBackendUrl.startsWith('http'));
}

async function liveApiFetch(path, { method = 'GET', body = null, headers = {} } = {}) {
  if (!liveIsEnabled()) throw new Error('Backend URL not configured.');
  const url = trimSlash(liveBackendUrl) + String(path || '');

  const h = {
    'Content-Type': 'application/json',
    ...headers,
  };
  if (liveAuthToken) h['Authorization'] = 'Bearer ' + liveAuthToken;

  const res = await fetch(url, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : null,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) ? (json.error || json.message) : (text || `HTTP ${res.status}`);
    throw new Error(msg);
  }

  return json;
}

function normalizeScoreHistoryItem(item) {
  const score = Number(item?.score || 0);
  const total = Number(item?.total || 0);
  const percent = total > 0 ? Math.round((score / total) * 1000) / 10 : 0;

  return {
    id: String(item?.id || ''),
    ts: Number(item?.ts || Date.now()),
    recordedAt: String(item?.recordedAt || ''),
    setId: String(item?.setId || ''),
    setTitle: String(item?.setTitle || 'Untitled Quiz'),
    folder: String(item?.folder || ''),
    source: String(item?.source || 'custom'),
    mode: String(item?.mode || 'exam'),
    score,
    total,
    percent,
  };
}

async function liveFetchMyScoreHistory() {
  if (!liveIsEnabled() || !liveAuthToken || !session?.username) {
    liveMyScoreHistory = [];
    renderMyScoreHistory();
    return false;
  }

  try {
    const json = await liveApiFetch('/api/scores', { method: 'GET' });
    liveMyScoreHistory = Array.isArray(json?.items)
      ? json.items.map(normalizeScoreHistoryItem)
      : [];
    renderMyScoreHistory();
    return true;
  } catch (err) {
    console.warn('Score history fetch failed:', err);
    renderMyScoreHistory();
    return false;
  }
}

async function liveSaveScoreHistory(entry) {
  if (!liveIsEnabled() || !liveAuthToken || !session?.username) return false;

  try {
    await liveApiFetch('/api/scores', {
      method: 'POST',
      body: entry,
    });
    await liveFetchMyScoreHistory();
    return true;
  } catch (err) {
    console.warn('Score history save failed:', err);
    return false;
  }
}

function renderMyScoreHistory() {
  const sub = document.getElementById('score-history-sub');
  const countEl = document.getElementById('score-history-count');
  const listEl = document.getElementById('score-history-list');
  if (!sub || !countEl || !listEl) return;

  const items = Array.isArray(liveMyScoreHistory) ? liveMyScoreHistory : [];
  countEl.textContent = String(items.length);

  if (!session?.username) {
    sub.textContent = 'Login to view your recent exam scores.';
    listEl.innerHTML = '<div class="text-gray-500 text-xs font-mono">(login required)</div>';
    return;
  }

  if (!liveIsEnabled()) {
    sub.textContent = 'Backend URL not set.';
    listEl.innerHTML = '<div class="text-gray-500 text-xs font-mono">(backend not configured)</div>';
    return;
  }

  if (!liveAuthToken) {
    sub.textContent = 'Login required.';
    listEl.innerHTML = '<div class="text-gray-500 text-xs font-mono">(not authenticated)</div>';
    return;
  }

  if (items.length === 0) {
    sub.textContent = 'Your exam submissions will appear here.';
    listEl.innerHTML = '<div class="text-gray-500 text-xs font-mono">No saved exam history yet.</div>';
    return;
  }

  sub.textContent = 'Stored on backend per account.';
  listEl.innerHTML = items.slice(0, 6).map(item => {
    const when = item.ts ? new Date(item.ts).toLocaleString() : '';
    const title = escapeHTML(item.setTitle || 'Untitled Quiz');
    const meta = escapeHTML((item.mode || 'exam').toUpperCase());
    const scoreText = escapeHTML(String(item.score) + '/' + String(item.total));
    const percentText = Number.isFinite(item.percent) ? escapeHTML(item.percent.toFixed(1) + '%') : '0.0%';
    const whenText = escapeHTML(when);

    return `
      <div class="border border-gray-800 rounded-lg px-3 py-2 bg-black/20">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-1">
          <div class="text-sm text-white font-semibold">${title}</div>
          <div class="text-xs font-mono text-[#00f3ff]">${scoreText} • ${percentText}</div>
        </div>
        <div class="text-[11px] font-mono text-gray-500 mt-1">${meta}${whenText ? ' • ' + whenText : ''}</div>
      </div>
    `;
  }).join('');
}

async function liveTryBackendLogin(username, password, captchaToken) {
  if (!liveIsEnabled()) return { ok: false, reason: 'no_backend' };

  try {
    const json = await liveApiFetch('/api/auth/login', {
      method: 'POST',
      body: {
        username,
        password,
        captchaToken
      },
    });

    if (json?.token) {
      setLiveToken(json.token);
      return {
        ok: true,
        token: json.token,
        user: json.user || { username, role: 'user' }
      };
    }

    return { ok: false, reason: 'no_token' };
  } catch (err) {
    return { ok: false, reason: 'error', error: err };
  }
}

function liveConnect() {
  if (!liveIsEnabled()) {
    updateLiveStatusUI();
    return;
  }

  if (!liveClientId) {
    // Stable per-device id (helps admin see duplicates).
    try {
      const stored = localStorage.getItem('padayon_client_id_v1');
      if (stored) liveClientId = stored;
    } catch (_) {}
    if (!liveClientId) {
      liveClientId = uid('client');
      try { localStorage.setItem('padayon_client_id_v1', liveClientId); } catch (_) {}
    }
  }

  // Already connected/connecting
  if (liveWs && (liveWs.readyState === WebSocket.OPEN || liveWs.readyState === WebSocket.CONNECTING)) {
    updateLiveStatusUI();
    return;
  }

  const wsUrl = httpToWsUrl(liveBackendUrl) + '/ws';
  try {
    liveWs = new WebSocket(wsUrl);
  } catch (err) {
    console.warn('Live WS init failed:', err);
    liveWs = null;
    scheduleLiveReconnect();
    updateLiveStatusUI();
    return;
  }

  liveWs.onopen = () => {
    liveWsConnected = true;
    liveReconnectDelayMs = 1000;
    updateLiveStatusUI();

    // Authenticate / identify.
    safeLiveSend({
      type: 'hello',
      token: liveAuthToken || null,
      username: session?.username || null,
      role: session?.role || null,
      clientId: liveClientId,
      ua: navigator.userAgent,
      ts: Date.now(),
    });

    // Send initial activity
    try { liveSetActivity('Online', { view: currentViewName() }); } catch (_) {}
  };

  liveWs.onmessage = (ev) => {
    const raw = String(ev?.data || '');
    if (!raw) return;
    let msg = null;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    handleLiveMessage(msg);
  };

  liveWs.onclose = () => {
    liveWsConnected = false;
    updateLiveStatusUI();
    scheduleLiveReconnect();
  };

  liveWs.onerror = () => {
    // onclose will fire after
    updateLiveStatusUI();
  };

  updateLiveStatusUI();
}

function liveDisconnect() {
  try { if (liveReconnectTimer) clearTimeout(liveReconnectTimer); } catch (_) {}
  liveReconnectTimer = null;
  liveReconnectDelayMs = 1000;

  try {
    if (liveWs) liveWs.close();
  } catch (_) {}

  liveWs = null;
  liveWsConnected = false;
  updateLiveStatusUI();
}

function scheduleLiveReconnect() {
  if (!liveIsEnabled()) return;
  if (liveReconnectTimer) return;

  const delay = Math.min(15000, Math.max(1000, liveReconnectDelayMs));
  liveReconnectDelayMs = Math.min(15000, delay * 1.6);

  liveReconnectTimer = setTimeout(() => {
    liveReconnectTimer = null;
    // Only reconnect if user is logged in
    if (session?.username) liveConnect();
  }, delay);
}

function safeLiveSend(obj) {
  try {
    if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return false;
    liveWs.send(JSON.stringify(obj));
    return true;
  } catch (_) {
    return false;
  }
}

function currentViewName() {
  // coarse view name for activity tracking
  if (!session?.username) return 'LOGIN';
  if (!document.getElementById('admin-overlay')?.classList.contains('hidden')) return 'ADMIN';
  if (!document.getElementById('pdf-overlay')?.classList.contains('hidden')) return 'PDF_VIEWER';
  if (!document.getElementById('notes-overlay')?.classList.contains('hidden')) return 'NOTES';
  if (!document.getElementById('quiz-browser-overlay')?.classList.contains('hidden')) return 'QUIZ_BROWSER';
  if (!document.getElementById('main-app')?.classList.contains('hidden')) return 'QUIZ_ENGINE';
  if (!document.getElementById('level-1-menu')?.classList.contains('hidden')) return 'CATEGORIES';
  // any submenu
  return 'MENUS';
}

function liveSetActivity(activity, extra = {}) {
  // Rate limit + avoid spamming identical state.
  const now = Date.now();
  const payload = {
    type: 'activity',
    activity: String(activity || '').slice(0, 180),
    view: extra.view || currentViewName(),
    path: extra.path || null,
    details: extra.details || null,
    ts: now,
  };

  // Only send if connected.
  if (!liveWsConnected) return;

  // Don't send too often.
  if (liveSetActivity._lastSentAt && (now - liveSetActivity._lastSentAt) < 350) return;
  liveSetActivity._lastSentAt = now;

  safeLiveSend(payload);
}

function handleLiveMessage(msg) {
  const t = String(msg.type || '');

  if (t === 'force_logout') {
  alert(msg.reason || 'This account was logged in on another device.');
  logoutToLogin();
  return;
}

  if (t === 'presence:public') {
    liveOnlinePublic = Array.isArray(msg.users) ? msg.users : [];
    renderOnlineUsersWidget();
    return;
  }

  if (t === 'presence:admin') {
    liveOnlineAdmin = Array.isArray(msg.users) ? msg.users : [];
    // Derive a public list too so the Categories widget still works for admin.
    liveOnlinePublic = liveOnlineAdmin.map(u => ({ username: u.username, role: u.role }));
    renderOnlineUsersWidget();
    renderAdminOnlineUsers();
    return;
  }

  if (t === 'library:changed') {
    const ms = Number(msg.ms || 0);
    // Only fetch if newer than our current library.
    if (ms && ms > getLibraryUpdatedAtMs(library)) {
      loadLibraryFromBackend();
    }
    return;
  }

  if (t === 'log:batch') {
    if (Array.isArray(msg.items)) {
      liveAdminLog = msg.items.slice(-200);
      renderAdminLog();
    }
    return;
  }

  if (t === 'log:append') {
    const item = msg.item;
    if (item && typeof item === 'object') {
      liveAdminLog.push(item);
      if (liveAdminLog.length > 200) liveAdminLog = liveAdminLog.slice(-200);
      renderAdminLog();
    }
    return;
  }

  if (t === 'hello:ack') {
    // Server acknowledged connection.
    updateLiveStatusUI(msg);
    liveFetchMyScoreHistory();
    // Ask for snapshots when admin.
    if (session?.role === 'admin') {
      safeLiveSend({ type: 'presence:request' });
      safeLiveSend({ type: 'log:request' });
    }
    return;
  }
}

function updateLiveStatusUI(serverHello = null) {
  // Category widget subtitle
  const sub = document.getElementById('online-users-sub');
  if (sub) {
    if (!session?.username) sub.textContent = 'Login to see online users.';
    else if (!liveIsEnabled()) sub.textContent = 'Backend URL not set.';
    else if (liveWsConnected) sub.textContent = 'Live connected.';
    else sub.textContent = 'Connecting…';
  }

  // Admin tab status
  const adminStatus = document.getElementById('admin-live-status');
  if (adminStatus) {
    if (!liveIsEnabled()) adminStatus.textContent = 'Backend: URL not set.';
    else if (liveWsConnected) adminStatus.textContent = 'Backend: connected (live).';
    else adminStatus.textContent = 'Backend: connecting…';
  }

  const acctStatus = document.getElementById('admin-account-status');
  if (acctStatus) {
    if (!liveIsEnabled()) acctStatus.textContent = 'Backend: URL not set.';
    else if (!liveAuthToken) acctStatus.textContent = 'Backend: not authenticated (login required).';
    else acctStatus.textContent = liveWsConnected ? 'Backend: authenticated + live connected.' : 'Backend: authenticated (connecting live)…';
  }

  renderMyScoreHistory();
}

function renderOnlineUsersWidget() {
  const countEl = document.getElementById('online-users-count');
  const listEl = document.getElementById('online-users-list');
  if (!countEl || !listEl) return;

  // Prefer public list (for users). Admin still sees public list here.
  const users = Array.isArray(liveOnlinePublic) ? liveOnlinePublic : [];
  countEl.textContent = String(users.length);

  if (!session?.username) {
    listEl.innerHTML = '<span class="text-gray-500 text-xs font-mono">(login required)</span>';
    return;
  }

  if (!liveIsEnabled()) {
    listEl.innerHTML = '<span class="text-gray-500 text-xs font-mono">(backend not configured)</span>';
    return;
  }

  if (!liveWsConnected) {
    listEl.innerHTML = '<span class="text-gray-500 text-xs font-mono">(connecting…)</span>';
    return;
  }

  if (users.length === 0) {
    listEl.innerHTML = '<span class="text-gray-500 text-xs font-mono">No one online.</span>';
    return;
  }

  // Pills
  listEl.innerHTML = users.map(u => {
    const name = escapeHTML(u?.username || 'user');
    return `<span class="admin-pill">🟢 ${name}</span>`;
  }).join('');
}

function renderAdminOnlineUsers() {
  const box = document.getElementById('admin-online-users-list');
  if (!box) return;

  if (session?.role !== 'admin') {
    box.innerHTML = '<div class="admin-help">Admin only.</div>';
    return;
  }

  if (!liveWsConnected) {
    box.innerHTML = '<div class="admin-help">Connecting…</div>';
    return;
  }

  const users = Array.isArray(liveOnlineAdmin) ? liveOnlineAdmin : [];
  if (users.length === 0) {
    box.innerHTML = '<div class="admin-help">No users online.</div>';
    return;
  }

  box.innerHTML = users.map(u => {
    const name = escapeHTML(u.username || 'user');
    const role = escapeHTML(u.role || 'user');
    const activity = escapeHTML(u.activity || 'Online');
    const path = u.path ? escapeHTML(String(u.path)) : '';
    const view = u.view ? escapeHTML(String(u.view)) : '';

    const meta = [activity, view ? ('VIEW: ' + view) : null, path ? ('PATH: ' + path) : null].filter(Boolean).join(' • ');

    return `
      <div class="admin-list-item">
        <div class="admin-list-left">
          <div class="admin-list-title">🟢 ${name}</div>
          <div class="admin-list-sub">${meta || ''}</div>
        </div>
        <div class="admin-list-right"><span class="admin-pill">${role}</span></div>
      </div>
    `;
  }).join('');
}

function renderAdminLog() {
  const box = document.getElementById('admin-activity-log');
  if (!box) return;
  if (session?.role !== 'admin') {
    box.innerHTML = '<div class="admin-help">Admin only.</div>';
    return;
  }
  if (!liveWsConnected) {
    box.innerHTML = '<div class="admin-help">Connecting…</div>';
    return;
  }

  const items = Array.isArray(liveAdminLog) ? liveAdminLog.slice(-120) : [];
  if (items.length === 0) {
    box.innerHTML = '<div class="admin-help">No activity yet.</div>';
    return;
  }

  box.innerHTML = items.slice().reverse().map(it => {
    const ts = it?.ts ? new Date(it.ts).toLocaleString() : '';
    const u = escapeHTML(it?.username || '');
    const m = escapeHTML(it?.message || '');
    return `
      <div class="admin-list-item">
        <div class="admin-list-left">
          <div class="admin-list-title">${u ? (u + ' • ') : ''}${escapeHTML(ts)}</div>
          <div class="admin-list-sub">${m}</div>
        </div>
      </div>
    `;
  }).join('');
}

function liveRequestAdminRefresh() {
  if (session?.role !== 'admin') return;
  safeLiveSend({ type: 'presence:request' });
  safeLiveSend({ type: 'log:request' });
}

function scheduleLiveLibraryPush(immediate = false) {
  if (session?.role !== 'admin') return;
  if (!liveIsEnabled()) return;
  if (!liveAuthToken) return;

  const libMs = getLibraryUpdatedAtMs(library);
  if (libMs <= liveLastLibraryPushedAtMs) return;

  try { if (liveLibraryPushTimer) clearTimeout(liveLibraryPushTimer); } catch (_) {}
  liveLibraryPushTimer = setTimeout(() => {
    liveLibraryPushTimer = null;
    livePushLibraryToBackend();
  }, immediate ? 10 : 900);
}

async function livePushLibraryToBackend() {
  if (session?.role !== 'admin') return;
  if (!liveIsEnabled()) return;
  if (!liveAuthToken) return;

  const libMs = getLibraryUpdatedAtMs(library);
  if (libMs <= liveLastLibraryPushedAtMs) return;

  try {
    // Don't mutate library.updatedAt here; touchLibrary() already did.
    await liveApiFetch('/api/library', { method: 'PUT', body: library });
    liveLastLibraryPushedAtMs = libMs;
    // Let server broadcast to all clients; admin doesn't need special handling.
  } catch (err) {
    console.warn('Live library push failed:', err);
  }
}

async function loadLibraryFromBackend() {
  if (!liveIsEnabled()) return false;
  try {
    const json = await liveApiFetch('/api/library', { method: 'GET' });
    const fetched = normalizeIncomingLibrary(json);

    const fetchedMs = getLibraryUpdatedAtMs(fetched);
    const currentMs = getLibraryUpdatedAtMs(library);
    if (fetchedMs && fetchedMs > currentMs) {
      library = fetched;
      libraryLoadState = { ok: true, source: 'backend', error: null };
      persistLibraryToCache();
      lastAppliedLibraryUpdatedAtMs = fetchedMs;
      try { refreshUiAfterLibraryChange(); } catch (_) {}
      try { updateAdminLibraryStatus(); } catch (_) {}
      return true;
    }
    return false;
  } catch (err) {
    // ignore
    return false;
  }
}

function emptyLibrary() {
  return {
    version: 2,
    updatedAt: null,
    folders: [], // array of { path: string, createdAt?: string }
    quizSets: [], // array of { id, title, folder, createdAt, updatedAt, questions: [] }
    pdfs: [], // array of { id, title, folder, kind: 'notes'|'archive', src: 'data:application/pdf;base64,...' or URL, createdAt }
  };
}

let library = emptyLibrary();
let libraryLoadState = { ok: false, source: 'empty', error: null };

// Used to avoid overwriting local edits when an async fetch finishes.
let libraryBootstrappedFromFallback = false;

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePath(input) {
  if (typeof input !== 'string') return '';
  let p = input.replace(/\\/g, '/');
  p = p.split('/').map(s => s.trim()).filter(Boolean).join('/');
  return p;
}

function samePath(a, b) {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

function isUnderPath(child, parent) {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  if (!p) return true;
  return c === p || c.startsWith(p + '/');
}

function parentPath(path) {
  const p = normalizePath(path);
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function baseName(path) {
  const p = normalizePath(path);
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function getAllFolderPaths() {
  const map = new Map();
  (library.folders || []).forEach(f => {
    const p = normalizePath(f?.path || '');
    if (p) map.set(p.toLowerCase(), p);
  });
  (library.quizSets || []).forEach(s => {
    const p = normalizePath(s?.folder || '');
    if (p) map.set(p.toLowerCase(), p);
  });
  (library.pdfs || []).forEach(p0 => {
    const p = normalizePath(p0?.folder || '');
    if (p) map.set(p.toLowerCase(), p);
  });
  return Array.from(map.values());
}

function getImmediateChildFolders(parent) {
  const parentN = normalizePath(parent);
  const parentLower = parentN.toLowerCase();
  const candidates = getAllFolderPaths();
  const out = new Map(); // lower child path -> {path,name}

  candidates.forEach(fp0 => {
    const fp = normalizePath(fp0);
    if (!fp) return;
    const fl = fp.toLowerCase();

    if (!parentN) {
      // Root: child is first segment
      const seg = fp.split('/')[0];
      if (!seg) return;
      const child = normalizePath(seg);
      out.set(child.toLowerCase(), { path: child, name: seg });
      return;
    }

    if (fl === parentLower) return;
    if (!fl.startsWith(parentLower + '/')) return;

    const rest = fp.slice(parentN.length + 1);
    const seg = rest.split('/')[0];
    if (!seg) return;
    const child = normalizePath(parentN + '/' + seg);
    out.set(child.toLowerCase(), { path: child, name: seg });
  });

  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function ensureFolder(path, lib = library) {
  // Ensure the full folder path *and its ancestors* exist.
  // This prevents child folders from appearing outside their parent category.
  const p = normalizePath(path);
  if (!p) return false;

  const parts = p.split('/').filter(Boolean);
  let cur = '';
  let changed = false;

  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const exists = lib.folders.some(f => samePath(f.path, cur));
    if (!exists) {
      lib.folders.push({ path: cur, createdAt: nowISO() });
      changed = true;
    }
  }

  return changed;
}

function persistLibraryToCache() {
  try {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(library));
    return true;
  } catch (_) {
    // ignore quota / private mode
    return false;
  }
}

function touchLibrary() {
  library.updatedAt = nowISO();
  const ok = persistLibraryToCache();
  if (ok) {
    lastAppliedLibraryUpdatedAtMs = getLibraryUpdatedAtMs(library);
    broadcastLibraryUpdated();
  }

  // ✅ Live sync (if backend is configured): push updates to server so all clients update instantly.
  // Debounced to avoid spamming.
  try { scheduleLiveLibraryPush(false); } catch (_) {}

  return ok;
}

function normalizeIncomingLibrary(data) {
  // Accept v2 (preferred)
  if (data && typeof data === 'object' && data.version === 2) {
    const out = emptyLibrary();
    out.updatedAt = data.updatedAt || null;
    out.folders = Array.isArray(data.folders) ? data.folders.filter(Boolean).map(f => ({
      path: normalizePath(f.path || ''),
      createdAt: f.createdAt || null,
    })).filter(f => f.path) : [];

    out.quizSets = Array.isArray(data.quizSets) ? data.quizSets.map(s => ({
      id: String(s.id || uid('qs')),
      title: String(s.title || 'Untitled'),
      folder: normalizePath(s.folder || 'GLOBAL'),
      createdAt: s.createdAt || null,
      updatedAt: s.updatedAt || null,
      questions: Array.isArray(s.questions) ? s.questions : [],
    })) : [];

    out.pdfs = Array.isArray(data.pdfs) ? data.pdfs.map(p => ({
      id: String(p.id || uid('pdf')),
      title: String(p.title || 'PDF'),
      folder: normalizePath(p.folder || 'GLOBAL'),
      kind: (p.kind === 'archive' ? 'archive' : 'notes'),
      src: String(p.src || ''),
      createdAt: p.createdAt || null,
    })) : [];

    // Folders implied by content
    out.quizSets.forEach(s => ensureFolder(s.folder, out));
    out.pdfs.forEach(p => ensureFolder(p.folder, out));
    return out;
  }

  // Accept old v1 (from earlier drafts): { quizSets:[], notes:[], archives:[], folders:{...} }
  if (data && typeof data === 'object' && data.version === 1) {
    const out = emptyLibrary();
    out.updatedAt = data.updatedAt || null;

    if (Array.isArray(data.quizSets)) {
      out.quizSets = data.quizSets.map(s => ({
        id: String(s.id || uid('qs')),
        title: String(s.title || 'Untitled'),
        folder: normalizePath(s.folder || 'GLOBAL'),
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || null,
        questions: Array.isArray(s.questions) ? s.questions : [],
      }));
    }

    const pdfs = [];
    if (Array.isArray(data.notes)) {
      data.notes.forEach(p => pdfs.push({ ...p, kind: 'notes' }));
    }
    if (Array.isArray(data.archives)) {
      data.archives.forEach(p => pdfs.push({ ...p, kind: 'archive' }));
    }

    out.pdfs = pdfs.map(p => ({
      id: String(p.id || uid('pdf')),
      title: String(p.title || 'PDF'),
      folder: normalizePath(p.folder || 'GLOBAL'),
      kind: (p.kind === 'archive' ? 'archive' : 'notes'),
      src: String(p.src || p.dataUrl || p.url || ''),
      createdAt: p.createdAt || null,
    }));

    // folders
    out.quizSets.forEach(s => ensureFolder(s.folder, out));
    out.pdfs.forEach(p => ensureFolder(p.folder, out));
    return out;
  }

  // fallback
  return emptyLibrary();
}

function getLibraryUpdatedAtMs(lib) {
  const t = Date.parse(String(lib?.updatedAt || ''));
  return Number.isFinite(t) ? t : 0;
}

function readLibraryCache() {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY);
    if (!raw) return null;
    const json = JSON.parse(raw);
    return normalizeIncomingLibrary(json);
  } catch (_) {
    return null;
  }
}

function isOverlayOpen(id) {
  const el = document.getElementById(id);
  return !!el && !el.classList.contains('hidden');
}

function refreshUiAfterLibraryChange() {
  // Admin panel
  if (isOverlayOpen('admin-overlay')) {
    try { updateAdminLibraryStatus(); } catch (_) {}
    try { adminRefreshAll(); } catch (_) {}
  }

  // Quiz browser overlay
  if (isOverlayOpen('quiz-browser-overlay')) {
    try { renderQuizBrowser(); } catch (_) {}
  }

  // Notes overlay
  if (isOverlayOpen('notes-overlay')) {
    try { renderNotesOverlayList(notesCurrentFolder); } catch (_) {}
  }
}

function maybeReloadLibraryFromCache(reason = 'cache') {
  const cached = readLibraryCache();
  if (!cached) return false;

  const cachedMs = getLibraryUpdatedAtMs(cached);
  const currentMs = getLibraryUpdatedAtMs(library);
  if (cachedMs <= currentMs) return false;

  library = normalizeIncomingLibrary(cached);
  libraryLoadState = { ok: true, source: 'cache', error: null };
  lastAppliedLibraryUpdatedAtMs = cachedMs;

  // Keep the UI in sync (user tab should see admin uploads instantly)
  try { refreshUiAfterLibraryChange(); } catch (_) {}
  return true;
}

function broadcastLibraryUpdated() {
  // localStorage setItem already triggers the `storage` event on other tabs.
  // BroadcastChannel is used as an extra fast-path.
  if (!librarySyncChannel) return;
  try {
    librarySyncChannel.postMessage({
      type: 'LIBRARY_UPDATED',
      updatedAt: library?.updatedAt || null,
      ms: getLibraryUpdatedAtMs(library),
    });
  } catch (_) {
    // ignore
  }
}

function initLibraryLiveSync() {
  if (librarySyncInitialized) return;
  librarySyncInitialized = true;

  // BroadcastChannel (best) + storage event (fallback)
  try {
    librarySyncChannel = new BroadcastChannel(LIBRARY_SYNC_CHANNEL);
    librarySyncChannel.onmessage = (ev) => {
      if (ev?.data?.type !== 'LIBRARY_UPDATED') return;
      // Apply only if it is newer
      maybeReloadLibraryFromCache('broadcast');
    };
  } catch (_) {
    librarySyncChannel = null;
  }

  // This fires in *other* tabs when localStorage changes.
  window.addEventListener('storage', (e) => {
    if (e?.key !== LIBRARY_CACHE_KEY) return;
    maybeReloadLibraryFromCache('storage');
  });

  // When the user returns to the tab, refresh once.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) maybeReloadLibraryFromCache('visibility');
  });
}

function loadLibraryFromFallbacks() {
  const candidates = [];

  // 1) Offline cache (latest local edits)
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY);
    if (raw) {
      const json = JSON.parse(raw);
      const norm = normalizeIncomingLibrary(json);
      candidates.push({ source: 'cache', lib: norm, ms: getLibraryUpdatedAtMs(norm) });
    }
  } catch (_) {
    // ignore
  }

  // 2) Bundled library.js (offline fallback file)
  try {
    const bundled = window[LIBRARY_GLOBAL_VAR];
    if (bundled && typeof bundled === 'object') {
      const norm = normalizeIncomingLibrary(bundled);
      candidates.push({ source: 'bundle', lib: norm, ms: getLibraryUpdatedAtMs(norm) });
    }
  } catch (_) {
    // ignore
  }

  if (candidates.length === 0) return false;

  // Pick newest by updatedAt; tie-breaker: prefer cache (unsaved work).
  candidates.sort((a, b) => {
    if (b.ms !== a.ms) return b.ms - a.ms;
    if (a.source === b.source) return 0;
    return a.source === 'cache' ? -1 : 1;
  });

  const best = candidates[0];
  library = best.lib;
  libraryLoadState = { ok: true, source: best.source, error: null };
  libraryBootstrappedFromFallback = true;
  return true;
}

async function loadLibraryFromRepo() {
  const isFile = window.location.protocol === 'file:';

  // Bootstrap from fallbacks first so the UI has *something* immediately.
  // This also prevents async fetch() from overwriting newer local edits.
  if (!libraryBootstrappedFromFallback) {
    loadLibraryFromFallbacks();
  }

  // If you're running via file:// the browser blocks fetch() for local JSON.
  // In that case: use offline fallbacks (cache + bundled library.js).
  if (isFile) {
    const ok = loadLibraryFromFallbacks();
    if (!ok) {
      library = emptyLibrary();
      libraryLoadState = { ok: false, source: 'empty', error: new Error('file:// cannot fetch library.json') };
    } else {
      persistLibraryToCache();
    }

    updateAdminLibraryStatus();
    if (!document.getElementById('admin-overlay')?.classList.contains('hidden')) adminRefreshAll();
    return;
  }

  // Normal (http/https) load
  try {
    const res = await fetch(LIBRARY_FILENAME, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const fetched = normalizeIncomingLibrary(json);

    // If we already have a (newer) cache/bundle edit, keep it.
    const fetchedMs = getLibraryUpdatedAtMs(fetched);
    const currentMs = getLibraryUpdatedAtMs(library);

    if (!libraryLoadState.ok || fetchedMs > currentMs) {
      library = fetched;
      libraryLoadState = { ok: true, source: 'repo', error: null };
      persistLibraryToCache();
    } else {
      // Keep local copy (cache/bundle/import) because it's newer.
      libraryLoadState = { ok: true, source: libraryLoadState.source || 'cache', error: null };
    }
  } catch (err) {
    console.warn('Library not found or invalid. Trying offline fallbacks…', err);

    const ok = loadLibraryFromFallbacks();
    if (!ok) {
      library = emptyLibrary();
      libraryLoadState = { ok: false, source: 'empty', error: err };
      console.warn('Library not found or invalid. Using empty library.', err);
    } else {
      persistLibraryToCache();
    }
  }

  // Track current version so cross-tab sync can compare properly
  lastAppliedLibraryUpdatedAtMs = getLibraryUpdatedAtMs(library);

  // Update admin status pill if admin panel exists
  updateAdminLibraryStatus();

  // Update any open overlay lists
  if (!document.getElementById('admin-overlay')?.classList.contains('hidden')) {
    adminRefreshAll();
  }
}

function downloadJSON(filename, obj) {
  const content = JSON.stringify(obj, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Admin “Save” = export current library.json (so it can be uploaded/committed to GitHub)
function adminSaveLibrary() {
  if (session.role !== 'admin') {
    alert('Admin only.');
    return;
  }

  // Ensure a fresh updatedAt timestamp for the export.
  touchLibrary();

  // ✅ Also push to backend (if configured) so clients update instantly.
  try { scheduleLiveLibraryPush(true); } catch (_) {}

  // Download the JSON (same as Backup → Export library.json)
  adminExportLibrary();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// =========================
// Login / Session
// =========================
function findAccount(usernameRaw, passwordRaw) {
  const u = String(usernameRaw || '').trim();
  const p = String(passwordRaw || '');
  return ACCOUNTS.find(a => a.username.toLowerCase() === u.toLowerCase() && a.password === p) || null;
}

function showLoginError() {
  const msg = document.getElementById('login-msg');
  if (msg) {
    msg.classList.remove('hidden');
    msg.classList.add('animate-pulse');
  }
}

function hideLoginError() {
  const msg = document.getElementById('login-msg');
  if (msg) msg.classList.add('hidden');
}

function setRememberMe(username, password) {
  const chk = document.getElementById('rememberMe');
  if (!chk) return;

  if (chk.checked) {
    const payload = { username, password };
    localStorage.setItem('padayon_remember', JSON.stringify(payload));
  } else {
    localStorage.removeItem('padayon_remember');
  }
}

function initRememberMe() {
  try {
    const raw = localStorage.getItem('padayon_remember');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data) return;

    const u = document.getElementById('username');
    const p = document.getElementById('password');
    const chk = document.getElementById('rememberMe');

    if (u && typeof data.username === 'string') u.value = data.username;
    if (p && typeof data.password === 'string') p.value = data.password;
    if (chk) chk.checked = true;
  } catch {
    // ignore
  }
}

// === LOGIN LOGIC (called by HTML) ===
async function verifyLogin() {
  const userIn = String(document.getElementById('username')?.value || '').trim();
  const passIn = String(document.getElementById('password')?.value || '');

  const loginPage = document.getElementById('login-page');
  const landingPage = document.getElementById('landing-page');
  const msg = document.getElementById('login-msg');

  // Reset any stale backend token from an older login.
  setLiveToken('');

  if (!userIn || !passIn) {
    if (msg) {
      msg.textContent = 'PLEASE ENTER USERNAME AND PASSWORD';
      msg.classList.remove('hidden');
    }
    return;
  }

  // Read reCAPTCHA token from the checkbox widget.
  // Google supports getting the token with grecaptcha.getResponse().
const captchaToken =
    (window.grecaptcha && typeof grecaptcha.getResponse === 'function')
      ? grecaptcha.getResponse()
      : '';

  if (!captchaToken) {
    if (msg) {
      msg.textContent = 'PLEASE CONFIRM YOU ARE NOT A ROBOT';
      msg.classList.remove('hidden');
    }
    return;
  }

  let acct = null;

  // IMPORTANT:
  // Secure login should go through backend verification.
  // Backend must verify captchaToken with Google using the secret key.
  if (liveIsEnabled()) {
    const res = await liveTryBackendLogin(userIn, passIn, captchaToken);

    if (res?.ok) {
      acct = {
        username: res.user?.username || userIn,
        role: res.user?.role || 'user',
      };
    } else {
      if (msg) {
        msg.textContent = (res?.error?.message || 'INVALID CREDENTIALS OR CAPTCHA FAILED').toUpperCase();
        msg.classList.remove('hidden');
      }

      const pw = document.getElementById('password');
      if (pw) pw.value = '';

      if (window.grecaptcha && typeof grecaptcha.reset === 'function') {
        grecaptcha.reset();
      }

      updateLiveStatusUI();
      return;
    }
  } else {
  if (msg) {
    msg.textContent = 'BACKEND NOT AVAILABLE';
    msg.classList.remove('hidden');
  }
  return;
}

  if (msg) msg.classList.add('hidden');

  hideLoginError();
  session = { username: acct.username, role: acct.role };
  liveMyScoreHistory = [];
  renderMyScoreHistory();
  setRememberMe(userIn, passIn);

  try {
    liveBackendUrl = getConfiguredBackendUrl();
    liveAuthToken = getLiveToken();
    updateLiveStatusUI();
    liveConnect();
  } catch (_) {
    // ignore
  }

  if (loginPage) {
    loginPage.style.opacity = '0';
    loginPage.style.transition = 'opacity 0.5s';
  }

  setTimeout(() => {
    if (loginPage) loginPage.style.display = 'none';

    const adminCard = document.getElementById('admin-card');
    if (adminCard) adminCard.classList.toggle('hidden', session.role !== 'admin');

    const adminQuickImport = document.getElementById('admin-quick-import');
    if (adminQuickImport) adminQuickImport.classList.toggle('hidden', session.role !== 'admin');

    if (landingPage) landingPage.classList.remove('hidden');

    try { liveSetActivity('Landing', { view: 'LANDING' }); } catch (_) {}
  }, 500);
}

function logoutToLogin() {
  try { liveSetActivity('Logout', { view: 'LOGIN' }); } catch (_) {}

  // Disconnect live backend presence
  try { liveDisconnect(); } catch (_) {}
  try { setLiveToken(''); } catch (_) {}

  session = { username: null, role: null };
  liveMyScoreHistory = [];
  renderMyScoreHistory();

  // Reset online UI
  try {
    liveOnlinePublic = [];
    liveOnlineAdmin = [];
    renderOnlineUsersWidget();
    renderAdminOnlineUsers();
    updateLiveStatusUI();
  } catch (_) {}

  // hide landing page
  document.getElementById('landing-page')?.classList.add('hidden');

  // hide everything
  document.querySelectorAll('.menu-overlay').forEach(el => el.classList.add('hidden'));
  const app = document.getElementById('main-app');
  if (app) {
    app.classList.add('hidden');
    app.style.opacity = '0';
  }

  // hide admin overlay
  document.getElementById('admin-overlay')?.classList.add('hidden');

  // show login
  const loginPage = document.getElementById('login-page');
  if (loginPage) {
    loginPage.style.display = 'block';
    loginPage.style.opacity = '1';
  }
}

// Enter key triggers login
document.addEventListener('DOMContentLoaded', () => {
  initRememberMe();

  const pw = document.getElementById('password');
  if (pw) {
    pw.addEventListener('keypress', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        verifyLogin();
      }
    });
  }

  // Forgot password
  const forgotLink = document.getElementById('forgotPassLink');
  if (forgotLink) {
    forgotLink.addEventListener('click', () => {
      document.getElementById('forgot-modal')?.classList.remove('hidden');
      document.getElementById('forgot-username')?.focus();
    });
  }

  // Click backdrop to close modal
  const forgotModal = document.getElementById('forgot-modal');
  if (forgotModal) {
    forgotModal.addEventListener('click', (e) => {
      if (e.target === forgotModal) closeForgotModal();
    });
  }

  // Load library as soon as DOM is ready
  initLibraryLiveSync();
  loadLibraryFromRepo();

  // Live backend (Render) settings
  liveBackendUrl = getConfiguredBackendUrl();
  liveAuthToken = getLiveToken();
  updateLiveStatusUI();
  renderMyScoreHistory();

  // If backend is configured, try loading library from there too.
  // (This enables true live updates without importing/exporting.)
  loadLibraryFromBackend();
});

function closeForgotModal() {
  document.getElementById('forgot-modal')?.classList.add('hidden');
}

function sendForgotEmail() {
  const u = String(document.getElementById('forgot-username')?.value || '').trim();
  const lp = String(document.getElementById('forgot-lastpass')?.value || '').trim();

  if (!u || !lp) {
    alert('Please enter username and last password you remember.');
    return;
  }

  const subject = encodeURIComponent('PADAYON PORTAL - Forgot Password');
  const body = encodeURIComponent(
    `Hi Admin,\n\nI forgot my password.\n\nUsername: ${u}\nLast password I remember: ${lp}\n\nThanks!`
  );

  // Opens default email client (static site cannot send directly)
  window.location.href = `mailto:bartnu137@gmail.com?subject=${subject}&body=${body}`;

  closeForgotModal();
}

// =========================
// Navigation
// =========================
function goToLevel1() {
  document.getElementById('landing-page')?.setAttribute('style', 'display:none;');
  document.getElementById('level-1-menu')?.classList.remove('hidden');
  try { liveSetActivity('Browsing Categories', { view: 'CATEGORIES' }); } catch (_) {}
}

function goToLevel2(category) {
  document.getElementById('level-1-menu')?.classList.add('hidden');
  ['submenu-undergrounds', 'submenu-taypi', 'submenu-exhale', 'submenu-pawer'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  document.getElementById('submenu-' + category)?.classList.remove('hidden');
  try { liveSetActivity('Open Category', { view: 'MENUS', details: String(category || '').toUpperCase() }); } catch (_) {}
}

function backToLevel1() {
  ['submenu-undergrounds', 'submenu-taypi', 'submenu-exhale', 'submenu-pawer'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  document.getElementById('level-1-menu')?.classList.remove('hidden');
  try { liveSetActivity('Back to Categories', { view: 'CATEGORIES' }); } catch (_) {}
}

function openTermsMenu() {
  document.getElementById('submenu-undergrounds')?.classList.add('hidden');
  document.getElementById('submenu-terms')?.classList.remove('hidden');
  try { liveSetActivity('Open Terms & Objectives', { view: 'MENUS', details: 'UNDERGROUNDS/TERMS & OBJECTIVES' }); } catch (_) {}
}

function closeTermsMenu() {
  document.getElementById('submenu-terms')?.classList.add('hidden');
  document.getElementById('submenu-undergrounds')?.classList.remove('hidden');
  try { liveSetActivity('Back to UNDERGROUNDS', { view: 'MENUS' }); } catch (_) {}
}

function openPastBoardList() {
  document.getElementById('submenu-terms')?.classList.add('hidden');
  document.getElementById('submenu-past-board-list')?.classList.remove('hidden');
  try { liveSetActivity('Open Past Board List', { view: 'MENUS' }); } catch (_) {}
}

function closePastBoardList() {
  document.getElementById('submenu-past-board-list')?.classList.add('hidden');
  document.getElementById('submenu-terms')?.classList.remove('hidden');
  try { liveSetActivity('Back to Terms List', { view: 'MENUS' }); } catch (_) {}
}

function callAdminNotice(moduleName) {
  alert(`${moduleName} is empty.\n\nCall admin to put something here.`);
}

// =========================
// Notes / PDF viewer
// =========================
let notesBackMenuId = null;
let notesRootFolder = null;
let notesCurrentFolder = null;
let notesCurrentKind = null; // 'notes'|'archive'|'all'
let notesOverlayTitle = 'NOTES';

function openNotesFolder(folderPath, title, backMenuId, kind = 'notes') {
  notesBackMenuId = backMenuId;
  notesRootFolder = normalizePath(folderPath);
  notesCurrentFolder = notesRootFolder;
  notesCurrentKind = kind;
  notesOverlayTitle = title || 'NOTES';

  // Hide back menu
  if (backMenuId) document.getElementById(backMenuId)?.classList.add('hidden');

  // Render list
  const titleEl = document.getElementById('notes-overlay-title');
  if (titleEl) titleEl.textContent = notesOverlayTitle;
  renderNotesOverlayList();

  document.getElementById('notes-overlay')?.classList.remove('hidden');

  try {
    const k = (kind === 'archive') ? 'ARCHIVE' : (kind === 'all' ? 'PDFs' : 'NOTES');
    liveSetActivity('Open ' + k, { view: 'NOTES', path: notesCurrentFolder || notesRootFolder || '' });
  } catch (_) {}
}

function closeNotesOverlay() {
  document.getElementById('notes-overlay')?.classList.add('hidden');
  if (notesBackMenuId) document.getElementById(notesBackMenuId)?.classList.remove('hidden');

  try { liveSetActivity('Close Notes', { view: currentViewName() }); } catch (_) {}

  notesBackMenuId = null;
  notesRootFolder = null;
  notesCurrentFolder = null;
  notesCurrentKind = null;
  notesOverlayTitle = 'NOTES';
}

function notesGoToFolder(folderPath) {
  const dest = normalizePath(folderPath);
  if (!dest) return;
  // Restrict browsing to the root folder passed to openNotesFolder
  if (notesRootFolder && !isUnderPath(dest, notesRootFolder)) return;
  notesCurrentFolder = dest;
  renderNotesOverlayList();

  try { liveSetActivity('Notes: Open Folder', { view: 'NOTES', path: notesCurrentFolder || '' }); } catch (_) {}
}

function notesGoUp() {
  const root = normalizePath(notesRootFolder || '');
  const cur = normalizePath(notesCurrentFolder || root);
  if (!cur) return;
  if (samePath(cur, root)) return;

  const parent = parentPath(cur);
  if (root && !isUnderPath(parent, root)) {
    notesCurrentFolder = root;
  } else {
    notesCurrentFolder = parent || root;
  }
  renderNotesOverlayList();

  try { liveSetActivity('Notes: Go Up', { view: 'NOTES', path: notesCurrentFolder || '' }); } catch (_) {}
}

// BACK button behaviour for Notes:
// - If inside a subfolder: go up to parent folder
// - If at the notes root: close the overlay
function notesBrowserBackOrClose() {
  const root = normalizePath(notesRootFolder || '');
  const cur = normalizePath(notesCurrentFolder || root);
  if (root && cur && !samePath(cur, root)) {
    notesGoUp();
    return;
  }
  closeNotesOverlay();
}

function renderNotesOverlayList() {
  const list = document.getElementById('notes-overlay-list');
  if (!list) return;

  const root = normalizePath(notesRootFolder || '');
  const folder = normalizePath(notesCurrentFolder || root || '');
  const kind = notesCurrentKind || 'notes'; // 'notes' | 'archive' | 'all'

  // path label
  const pathEl = document.getElementById('notes-overlay-path');
  if (pathEl) {
    pathEl.textContent = `PATH: ${folder || 'ROOT'}`;
  }

  const atRoot = samePath(folder, root);

  const folders = getImmediateChildFolders(folder)
    .filter(f => (root ? isUnderPath(f.path, root) : true))
    .filter(f => !samePath(f.path, folder));

  const pdfsHere = (library.pdfs || [])
    .filter(p => (kind === 'all' ? true : p.kind === kind))
    .filter(p => {
      if (isGlobalFolder(p.folder)) return atRoot;

      // IMPORTANT: show PDFs ONLY in the folder they were attached to.
      // (Previously root view showed PDFs from all subfolders, which caused “duplicate” PDFs
      // to appear both outside and inside the target folder.)
      return samePath(p.folder, folder);
    });

  const cards = [];

  // Folder cards
  folders.forEach(f => {
    const pdfCount = (library.pdfs || [])
      .filter(p => (kind === 'all' ? true : p.kind === kind))
      .filter(p => isUnderPath(p.folder, f.path)).length;

    cards.push(`
      <div class="cyber-card p-6 rounded-lg text-center cursor-pointer hover:border-[#00f3ff] transition-all" onclick="notesGoToFolder('${f.path.replace(/'/g, "\\'")}')">
        <div class="text-4xl mb-4 text-[#00f3ff]">📁</div>
        <div class="font-bold text-lg">${escapeHTML(f.name)}</div>
        <div class="text-gray-500 text-xs font-mono mt-2">${pdfCount} PDF${pdfCount === 1 ? '' : 's'}</div>
      </div>
    `);
  });

  // PDF cards
  pdfsHere.forEach(p => {
    const safeTitle = escapeHTML(p.title || 'PDF');
    const sub = escapeHTML(isGlobalFolder(p.folder) ? 'GLOBAL' : (p.folder || 'ROOT'));
    cards.push(`
      <div class="cyber-card p-6 rounded-lg text-center cursor-pointer hover:border-[#00f3ff] transition-all" onclick="openPdfOverlay('${p.id.replace(/'/g, "\\'")}')">
        <div class="text-4xl mb-4 text-[#00f3ff]">📄</div>
        <div class="font-bold text-lg">${safeTitle}</div>
        <div class="text-gray-500 text-xs font-mono mt-2">${sub}</div>
      </div>
    `);
  });

  if (cards.length === 0) {
    list.innerHTML = `
      <div class="cyber-card p-6 rounded-lg md:col-span-3">
        <div class="text-gray-300 font-mono text-sm">No PDFs or folders found in <span class="text-[#00f3ff]">${escapeHTML(folder || 'ROOT')}</span>.</div>
        <div class="text-gray-500 font-mono text-xs mt-2">Ask admin to upload PDFs in Admin Panel → Notes (PDF), or create folders in Admin Panel → Archive Folder.</div>
      </div>
    `;
    return;
  }

  list.innerHTML = cards.join('');
}

function getPdfById(id) {
  return library.pdfs.find(p => p.id === id) || null;
}

// If opened from admin, we want to return to admin overlay instead of notes overlay.
let pdfBackOverlayId = null;

function openPdfOverlay(pdfId, backOverlayId = null) {
  const pdf = getPdfById(pdfId);
  if (!pdf) {
    alert('PDF not found in library.');
    return;
  }

  pdfBackOverlayId = backOverlayId;

  // Hide whoever opened it
  if (backOverlayId) {
    document.getElementById(backOverlayId)?.classList.add('hidden');
  }

  // Hide notes overlay too (if it was the opener)
  document.getElementById('notes-overlay')?.classList.add('hidden');

  const titleEl = document.getElementById('pdf-overlay-title');
  if (titleEl) titleEl.textContent = pdf.title || 'PDF';

  const frame = document.getElementById('pdf-frame');
  if (frame) frame.src = pdf.src;

  const dl = document.getElementById('pdf-download');
  if (dl) {
    dl.href = pdf.src;
    const filename = (pdf.title || 'notes').replace(/[^a-z0-9\-\_]+/gi, '_') + '.pdf';
    dl.setAttribute('download', filename);
  }

  document.getElementById('pdf-overlay')?.classList.remove('hidden');

  try {
    liveSetActivity('Open PDF', {
      view: 'PDF_VIEWER',
      path: pdf.folder || '',
      details: pdf.title || 'PDF',
    });
  } catch (_) {}
}

function closePdfOverlay() {
  document.getElementById('pdf-overlay')?.classList.add('hidden');

  const frame = document.getElementById('pdf-frame');
  if (frame) frame.src = '';

  if (pdfBackOverlayId) {
    document.getElementById(pdfBackOverlayId)?.classList.remove('hidden');
    pdfBackOverlayId = null;

    try { liveSetActivity('Back from PDF', { view: currentViewName() }); } catch (_) {}
    return;
  }

  document.getElementById('notes-overlay')?.classList.remove('hidden');

  try { liveSetActivity('Back from PDF', { view: 'NOTES', path: notesCurrentFolder || '' }); } catch (_) {}
}

function escapeHTML(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// =========================
// Custom Quiz Sets Browser
// =========================
let quizBrowserBackMenuId = null;
let quizBrowserRootFolder = null;
let quizBrowserCurrentFolder = null;
let quizBrowserTitle = 'QUIZ SETS';

function isGlobalFolder(path) {
  const p = normalizePath(path).toLowerCase();
  return p === 'global' || p.startsWith('global/') || p === 'all' || p.startsWith('all/');
}

function openCustomQuizBrowser(prefixPath, backMenuId, title) {
  quizBrowserBackMenuId = backMenuId;
  quizBrowserRootFolder = normalizePath(prefixPath);
  quizBrowserCurrentFolder = quizBrowserRootFolder;
  quizBrowserTitle = title || 'QUIZ SETS';

  if (backMenuId) document.getElementById(backMenuId)?.classList.add('hidden');

  const titleEl = document.getElementById('quiz-browser-title');
  if (titleEl) titleEl.textContent = quizBrowserTitle;

  renderQuizBrowser();
  document.getElementById('quiz-browser-overlay')?.classList.remove('hidden');

  try {
    liveSetActivity('Open Quiz Browser', { view: 'QUIZ_BROWSER', path: quizBrowserCurrentFolder || quizBrowserRootFolder || '' });
  } catch (_) {}
}

function closeCustomQuizBrowser() {
  document.getElementById('quiz-browser-overlay')?.classList.add('hidden');
  if (quizBrowserBackMenuId) document.getElementById(quizBrowserBackMenuId)?.classList.remove('hidden');

  try { liveSetActivity('Close Quiz Browser', { view: currentViewName() }); } catch (_) {}

  quizBrowserBackMenuId = null;
  quizBrowserRootFolder = null;
  quizBrowserCurrentFolder = null;
  quizBrowserTitle = 'QUIZ SETS';
}

function quizBrowserGoToFolder(folderPath) {
  const dest = normalizePath(folderPath);
  if (!dest) return;
  if (quizBrowserRootFolder && !isUnderPath(dest, quizBrowserRootFolder)) return;
  quizBrowserCurrentFolder = dest;
  renderQuizBrowser();

  try { liveSetActivity('Quiz Browser: Open Folder', { view: 'QUIZ_BROWSER', path: quizBrowserCurrentFolder || '' }); } catch (_) {}
}

function quizBrowserGoUp() {
  const root = normalizePath(quizBrowserRootFolder || '');
  const cur = normalizePath(quizBrowserCurrentFolder || root);
  if (!cur) return;
  if (samePath(cur, root)) return;

  const parent = parentPath(cur);
  if (root && !isUnderPath(parent, root)) {
    quizBrowserCurrentFolder = root;
  } else {
    quizBrowserCurrentFolder = parent || root;
  }
  renderQuizBrowser();

  try { liveSetActivity('Quiz Browser: Go Up', { view: 'QUIZ_BROWSER', path: quizBrowserCurrentFolder || '' }); } catch (_) {}
}

// BACK button behaviour for Quiz Browser:
// - If inside a subfolder: go up to parent folder
// - If at the category root: close the browser
function quizBrowserBackOrClose() {
  const root = normalizePath(quizBrowserRootFolder || '');
  const cur = normalizePath(quizBrowserCurrentFolder || root);
  if (root && cur && !samePath(cur, root)) {
    quizBrowserGoUp();
    return;
  }
  closeCustomQuizBrowser();
}

function renderQuizBrowser() {
  const grid = document.getElementById('quiz-browser-list');
  if (!grid) return;

  const root = normalizePath(quizBrowserRootFolder || '');
  const folder = normalizePath(quizBrowserCurrentFolder || root || '');

  const pathEl = document.getElementById('quiz-browser-path');
  if (pathEl) {
    pathEl.textContent = `PATH: ${folder || 'ROOT'}`;
  }

  const atRoot = samePath(folder, root);

  const folders = getImmediateChildFolders(folder)
    .filter(f => (root ? isUnderPath(f.path, root) : true))
    .filter(f => !samePath(f.path, folder));

  // Show only sets directly inside the current folder.
  // (GLOBAL sets are shown only at the category root.)
  const setsHere = (library.quizSets || [])
    .filter(s => {
      if (isGlobalFolder(s.folder)) return atRoot;
      return samePath(s.folder, folder);
    });

  const cards = [];

  // Folder cards
  folders.forEach(f => {
    const setCount = (library.quizSets || []).filter(s => isUnderPath(s.folder, f.path) && !isGlobalFolder(s.folder)).length;
    cards.push(`
      <div class="cyber-card p-6 rounded-lg text-center cursor-pointer hover:border-[#00f3ff] transition-all" onclick="quizBrowserGoToFolder('${f.path.replace(/'/g, "\\'")}')">
        <div class="text-4xl mb-4 text-[#00f3ff]">📁</div>
        <div class="font-bold text-lg">${escapeHTML(f.name)}</div>
        <div class="text-gray-500 text-xs font-mono mt-2">${setCount} set${setCount === 1 ? '' : 's'}</div>
      </div>
    `);
  });

  // Set cards
  setsHere
    .slice()
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')))
    .forEach(s => {
      const title = escapeHTML(s.title);
      const count = Array.isArray(s.questions) ? s.questions.length : 0;
      const folderLabel = escapeHTML(isGlobalFolder(s.folder) ? 'GLOBAL' : (s.folder || ''));
      cards.push(`
        <div class="cyber-card p-6 rounded-lg cursor-pointer hover:border-[#00f3ff] transition-all duration-200 hover:bg-[#1a1a24] group" onclick="loadQuizCustom('${s.id.replace(/'/g, "\\'")}', '${(quizBrowserBackMenuId || '').replace(/'/g, "\\'")}')">
          <div class="flex items-center justify-between">
            <div class="text-3xl text-[#00f3ff]">🧠</div>
            <div class="text-gray-500 text-xs font-mono">${count} Q</div>
          </div>
          <div class="mt-4 font-bold text-lg text-white group-hover:text-[#00f3ff] transition-colors">${title}</div>
          <div class="text-gray-600 text-[10px] font-mono mt-3">${folderLabel}</div>
        </div>
      `);
    });

  if (cards.length === 0) {
    grid.innerHTML = `
      <div class="cyber-card p-6 rounded-lg md:col-span-3">
        <div class="text-gray-300 font-mono text-sm">No custom quiz sets found in <span class="text-[#00f3ff]">${escapeHTML(folder || 'ROOT')}</span>.</div>
        <div class="text-gray-500 font-mono text-xs mt-2">Ask admin to create quiz sets in Admin Panel → Quiz Set.</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = cards.join('');
}

// =========================
// Quiz Engine
// =========================
let currentMode = 'review';
let currentQuestions = [];
let userAnswers = {};
let practiceAttempts = {};
let examSubmitted = false;

const container = document.getElementById('questions-container');
const examDashboard = document.getElementById('exam-dashboard');
const practiceDashboard = document.getElementById('practice-dashboard');
const scoreDisplay = document.getElementById('score-display');
const examStatus = document.getElementById('exam-status');
const submitBtn = document.getElementById('submit-btn');

function loadQuiz(type) {
  const app = document.getElementById('main-app');
  const title = document.getElementById('active-module-title');

  let liveTitle = '';

  if (type === 'math') {
    currentQuestions = typeof mathData !== 'undefined' ? [...mathData] : [];
    if (title) {
      title.innerHTML = 'MATHEMATICS';
      title.className = 'text-[#00f3ff]';
    }
    liveTitle = 'MATHEMATICS';
    activeMenu = 'submenu-taypi';
  } else if (type === 'esas') {
    currentQuestions = typeof esasData !== 'undefined' ? [...esasData] : [];
    if (title) {
      title.innerHTML = 'ESAS';
      title.className = 'text-[#ff00ff]';
    }
    liveTitle = 'ESAS';
    activeMenu = 'submenu-taypi';
  } else if (type === 'ug1') {
    currentQuestions = typeof esasUG1Data !== 'undefined' ? [...esasUG1Data] : [];
    if (title) {
      title.innerHTML = 'PAST BOARD 1';
      title.className = 'text-[#00f3ff]';
    }
    liveTitle = 'PAST BOARD 1';
    activeMenu = 'submenu-past-board-list';
  } else if (type === 'ug2') {
    currentQuestions = typeof esasUG2Data !== 'undefined' ? [...esasUG2Data] : [];
    if (title) {
      title.innerHTML = 'PAST BOARD 2';
      title.className = 'text-[#00f3ff]';
    }
    liveTitle = 'PAST BOARD 2';
    activeMenu = 'submenu-past-board-list';
  } else if (type === 'ug3') {
    currentQuestions = typeof esasUG3Data !== 'undefined' ? [...esasUG3Data] : [];
    if (title) {
      title.innerHTML = 'PAST BOARD 3';
      title.className = 'text-[#00f3ff]';
    }
    liveTitle = 'PAST BOARD 3';
    activeMenu = 'submenu-past-board-list';
  } else {
    alert('Module Under Construction');
    return;
  }

  currentQuizMeta = {
    id: String(type || ''),
    title: liveTitle || String(type || '').toUpperCase(),
    folder: (type === 'math' || type === 'esas') ? 'T-AY-PI' : 'UNDERGROUNDS/TERMS & OBJECTIVES/ESAS PAST BOARD',
    source: 'built_in',
  };

  // Hide all overlays (including notes/quiz browser)
  document.querySelectorAll('.menu-overlay').forEach(el => el.classList.add('hidden'));

  if (app) app.classList.remove('hidden');

  currentMode = 'review';
  resetExam();
  resetPractice();
  setMode('review');

  try {
    liveSetActivity('Start Built-in Quiz', {
      view: 'QUIZ_ENGINE',
      details: liveTitle || String(type || '').toUpperCase(),
    });
  } catch (_) {}

  setTimeout(() => {
    if (app) app.style.opacity = '1';
  }, 100);
}

function loadQuizCustom(setId, backMenuId) {
  const set = library.quizSets.find(s => s.id === setId);
  if (!set) {
    alert('Quiz set not found in library.');
    return;
  }

  const app = document.getElementById('main-app');
  const title = document.getElementById('active-module-title');

  // Deep clone to avoid accidental edits
  currentQuestions = Array.isArray(set.questions) ? set.questions.map(q => ({
    id: q.id,
    key: q.key,
    topic: q.topic || 'Custom',
    q: q.q,
    options: q.options || { a: '', b: '', c: '', d: '' },
    ans: q.ans || ((q.options && q.key) ? q.options[q.key] : ''),
    soln: q.soln || '',
    caltech: q.caltech || null,
  })) : [];

  if (title) {
    title.innerHTML = escapeHTML(set.title || 'CUSTOM SET');
    title.className = 'text-[#00f3ff]';
  }

  // Set active menu back location
  activeMenu = backMenuId || quizBrowserBackMenuId || 'level-1-menu';
  currentQuizMeta = {
    id: String(set.id || ''),
    title: String(set.title || 'CUSTOM SET'),
    folder: String(set.folder || ''),
    source: 'custom',
  };

  // Hide all overlays
  document.querySelectorAll('.menu-overlay').forEach(el => el.classList.add('hidden'));

  if (app) app.classList.remove('hidden');

  currentMode = 'review';
  resetExam();
  resetPractice();
  setMode('review');

  try {
    liveSetActivity('Start Custom Quiz', {
      view: 'QUIZ_ENGINE',
      path: set.folder || '',
      details: set.title || 'CUSTOM SET',
    });
  } catch (_) {}

  setTimeout(() => {
    if (app) app.style.opacity = '1';
  }, 100);
}

function backToQuizMenu() {
  const app = document.getElementById('main-app');
  if (!app) return;

  try { liveSetActivity('Exit Quiz', { view: 'MENUS' }); } catch (_) {}

  app.style.opacity = '0';
  setTimeout(() => {
    app.classList.add('hidden');
    const menu = document.getElementById(activeMenu);
    if (menu) menu.classList.remove('hidden');
    else document.getElementById('level-1-menu')?.classList.remove('hidden');
  }, 500);
}

function setMode(mode) {
  currentMode = mode;
  ['review', 'practice', 'exam'].forEach(m => {
    const btn = document.getElementById(`btn-${m}`);
    if (btn) btn.className = `mode-btn ${mode === m ? 'active' : 'inactive'}`;
  });
  if (examDashboard) examDashboard.classList.toggle('hidden', mode !== 'exam');
  if (practiceDashboard) practiceDashboard.classList.toggle('hidden', mode !== 'practice');
  renderQuestions();

  try {
    const t = String(document.getElementById('active-module-title')?.innerText || '').trim();
    const label = t ? (t + ' • ' + mode.toUpperCase()) : mode.toUpperCase();
    liveSetActivity('Mode Change', { view: 'QUIZ_ENGINE', details: label });
  } catch (_) {}
}

function resetExam() {
  userAnswers = {};
  examSubmitted = false;

  if (examStatus) {
    examStatus.innerText = 'RUNNING';
    examStatus.classList.remove('text-[#00ff9d]');
    examStatus.classList.add('text-yellow-500');
  }

  if (scoreDisplay) scoreDisplay.innerText = '--';

  const totalDisplay = document.getElementById('total-score');
  if (totalDisplay) totalDisplay.innerText = '/ --';

  if (submitBtn) {
    submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    submitBtn.disabled = false;
  }

  renderQuestions();
}

function resetPractice() {
  practiceAttempts = {};
  renderQuestions();
}

function selectExamOption(qId, option) {
  if (examSubmitted) return;
  userAnswers[qId] = option;
  renderQuestions();
}

function selectPracticeOption(qId, option) {
  if (practiceAttempts[qId]) return;
  const q = currentQuestions.find(item => item.id === qId);
  if (!q) return;
  practiceAttempts[qId] = { selected: option, isCorrect: option === q.key };
  renderQuestions();
}

function submitExam() {
  if (examSubmitted) return;
  examSubmitted = true;

  let score = 0;
  currentQuestions.forEach(q => {
    if (userAnswers[q.id] === q.key) score++;
  });

  if (scoreDisplay) scoreDisplay.innerText = String(score);

  try {
    liveSetActivity('Submit Exam', {
      view: 'QUIZ_ENGINE',
      details: `Score: ${score}/${currentQuestions.length}`,
    });
  } catch (_) {}

  const totalDisplay = document.getElementById('total-score');
  if (totalDisplay) totalDisplay.innerText = '/ ' + currentQuestions.length;

  if (examStatus) {
    examStatus.innerText = 'COMPLETED';
    examStatus.classList.remove('text-yellow-500');
    examStatus.classList.add('text-[#00ff9d]');
  }

  if (submitBtn) {
    submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
    submitBtn.disabled = true;
  }

  try {
    liveSaveScoreHistory({
      setId: currentQuizMeta.id || null,
      setTitle: currentQuizMeta.title || String(document.getElementById('active-module-title')?.innerText || '').trim() || 'Untitled Quiz',
      folder: currentQuizMeta.folder || '',
      source: currentQuizMeta.source || 'custom',
      mode: 'exam',
      score,
      total: currentQuestions.length,
    });
  } catch (_) {}

  renderQuestions();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderQuestions() {
  if (!container) return;

  container.innerHTML = '';

  currentQuestions.forEach(item => {
    const isExam = currentMode === 'exam';
    const isPractice = currentMode === 'practice';
    const hasCalTech = !!item.caltech;

    let cardClass = 'cyber-card rounded-lg p-6 flex flex-col gap-4';
    if (isExam && examSubmitted) {
      const sel = userAnswers[item.id];
      if (sel === item.key) cardClass += ' correct';
      else if (sel) cardClass += ' wrong';
    }
    if (isPractice && practiceAttempts[item.id]) {
      if (practiceAttempts[item.id].isCorrect) cardClass += ' correct';
      else cardClass += ' wrong';
    }

    const caltechBadge = `<span class="bg-gray-800 border border-[#00f3ff] text-[#00f3ff] text-xs px-2 py-1 rounded font-mono flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-[#00f3ff] animate-pulse"></span> CALTECH</span>`;

    const topicText = escapeHTML(item.topic || '');

    let html = `
      <div class="flex justify-between items-start">
        <div class="flex items-center gap-3">
          <span class="text-3xl font-bold text-gray-700 font-mono">#${item.id}</span>
          ${topicText ? `<span class="text-xs text-[#ff00ff] border border-[#ff00ff] px-2 rounded uppercase tracking-wider">${topicText}</span>` : ''}
        </div>
        ${(currentMode !== 'exam' && hasCalTech) ? caltechBadge : ''}
      </div>
      <div class="text-lg font-medium text-gray-200">${item.q}</div>
    `;

    if (isExam || isPractice) {
      html += `<div class="opt-container">`;
      ['a', 'b', 'c', 'd'].forEach(key => {
        let btnClass = 'opt-btn';
        let onclick = '';

        if (isExam) {
          onclick = `selectExamOption(${item.id}, '${key}')`;
          const sel = userAnswers[item.id];
          if (examSubmitted) {
            if (key === item.key) btnClass += ' correct-ans';
            else if (sel === key) btnClass += ' wrong-ans';
            else btnClass += ' dimmed';
          } else if (sel === key) {
            btnClass += ' selected';
          }
        } else if (isPractice) {
          onclick = `selectPracticeOption(${item.id}, '${key}')`;
          const attempt = practiceAttempts[item.id];
          if (attempt) {
            if (key === item.key) btnClass += ' correct-ans';
            else if (attempt.selected === key) btnClass += ' wrong-ans';
            else btnClass += ' dimmed';
          }
        }

        html += `
          <div onclick="${onclick}" class="${btnClass}">
            <div class="opt-letter">${key.toUpperCase()}</div>
            <div class="flex-1">${item.options?.[key] || ('Option ' + key)}</div>
          </div>
        `;
      });
      html += `</div>`;

      const showSoln = (isExam && examSubmitted) || (isPractice && practiceAttempts[item.id]);
      if (showSoln) {
        html += `
          <div class="mt-4 pt-4 border-t border-gray-800 text-sm animate-fade-in">
            <div class="text-gray-300 bg-gray-900/80 p-3 rounded border-l-2 border-[#00ff9d]">
              <div class="text-[#00ff9d] text-xs font-bold mb-1">SOLUTION:</div>
              ${item.soln || '<span class="text-gray-500">(no solution provided)</span>'}
            </div>
            ${item.caltech ? `<div class="mt-2 bg-[#1a1a24] p-2 rounded border border-gray-700 font-mono text-xs text-gray-400">⌨️ ${item.caltech}</div>` : ''}
          </div>
        `;
      }
    } else {
      html += `
        <div class="mt-2 p-3 bg-black/40 border-l-2 border-yellow-500 text-yellow-500 font-mono text-sm">
          ANSWER: ${item.ans || ''} <span class="text-gray-500 text-xs ml-2">[Option ${(item.key || '').toUpperCase()}]</span>
        </div>
        <button onclick="document.getElementById('soln-${item.id}').classList.toggle('hidden')" 
          class="mt-auto w-full py-2 bg-[#1f1f2e] hover:bg-[#2d2d3a] text-gray-300 text-sm font-bold uppercase tracking-widest transition-colors border-t border-gray-700 flex justify-center items-center gap-2">
          <span>View Protocol</span>
        </button>
        <div id="soln-${item.id}" class="hidden pt-4 border-t border-gray-800 space-y-4">
          <div class="text-gray-400 text-sm">
            <strong class="text-[#00f3ff]">SOLUTION:</strong><br>
            <div class="mt-2">${item.soln || '<span class="text-gray-500">(no solution provided)</span>'}</div>
          </div>
          ${item.caltech ? `<div class="bg-[#1a1a24] p-3 rounded border border-gray-700 font-mono text-sm text-gray-300 leading-8">${item.caltech}</div>` : ''}
        </div>
      `;
    }

    const el = document.createElement('div');
    el.className = cardClass;
    el.innerHTML = html;
    container.appendChild(el);
  });

  if (window.MathJax) MathJax.typesetPromise();
}

// =========================
// Admin Panel
// =========================
let adminTab = 'content';
let adminCreateType = 'quiz'; // quiz|notes|folder
let adminSelectedQuizSetId = '';

function openAdminPanel() {
  if (session.role !== 'admin') {
    alert('Admin access only.');
    return;
  }

  // Hide all menus and quiz app
  document.querySelectorAll('.menu-overlay').forEach(el => el.classList.add('hidden'));
  const app = document.getElementById('main-app');
  if (app) {
    app.classList.add('hidden');
    app.style.opacity = '0';
  }

  // Show admin
  document.getElementById('admin-overlay')?.classList.remove('hidden');
  setAdminTab('content');

  try { liveSetActivity('Open Admin Panel', { view: 'ADMIN' }); } catch (_) {}
  try { liveRequestAdminRefresh(); } catch (_) {}

  updateAdminLibraryStatus();
  showLibraryHintIfNeeded();
  adminRefreshAll();
}

function closeAdminPanel() {
  document.getElementById('admin-overlay')?.classList.add('hidden');
  document.getElementById('level-1-menu')?.classList.remove('hidden');

  try { liveSetActivity('Close Admin Panel', { view: 'CATEGORIES' }); } catch (_) {}
}

function updateAdminLibraryStatus() {
  const pill = document.getElementById('admin-library-status');
  if (!pill) return;

  if (libraryLoadState.ok) {
    const src = libraryLoadState.source;
    const srcLabel =
      src === 'repo' ? LIBRARY_FILENAME :
      src === 'bundle' ? LIBRARY_JS_FILENAME :
      src === 'cache' ? 'OFFLINE CACHE' :
      String(src || 'UNKNOWN');
    pill.textContent = `LIBRARY: LOADED (${srcLabel})`;
    pill.style.borderColor = 'rgba(0, 255, 157, 0.55)';
  } else {
    pill.textContent = 'LIBRARY: EMPTY (import in Backup)';
    pill.style.borderColor = 'rgba(255, 0, 85, 0.55)';
  }

  showLibraryHintIfNeeded();
}

function showLibraryHintIfNeeded() {
  const hint = document.getElementById('admin-library-hint');
  if (!hint) return;

  const isFile = window.location.protocol === 'file:';
  const src = libraryLoadState.source;

  if (!libraryLoadState.ok && isFile) {
    hint.classList.remove('hidden');
    hint.textContent = "You're opening via file://, so the browser blocks fetch() for library.json. Use a local server (VSCode Live Server / python -m http.server) OR use library.js (offline bundle).";
    return;
  }

  if (!libraryLoadState.ok) {
    hint.classList.remove('hidden');
    hint.textContent = "library.json not found (or invalid). You can import one in Backup tab, then export a fresh library.json.";
    return;
  }

  // If we loaded from offline bundle/cache, show a helpful note.
  if (isFile && (src === 'bundle' || src === 'cache')) {
    hint.classList.remove('hidden');
    hint.textContent = "Offline mode: loaded library from " + (src === 'bundle' ? "library.js" : "offline cache") + ". To share on GitHub Pages: export library.json and commit it.";
    return;
  }

  hint.classList.add('hidden');
}

function setAdminTab(tab) {
  adminTab = tab;

  // tabs
  const tabs = {
    content: 'admin-tab-content',
    accounts: 'admin-tab-accounts',
    logs: 'admin-tab-logs',
    backup: 'admin-tab-backup',
  };

  Object.entries(tabs).forEach(([k, id]) => {
    document.getElementById(id)?.classList.toggle('hidden', k !== tab);
  });

  // nav active
  const navMap = {
    content: 'admin-nav-content',
    accounts: 'admin-nav-accounts',
    logs: 'admin-nav-logs',
    backup: 'admin-nav-backup',
  };
  Object.values(navMap).forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById(navMap[tab])?.classList.add('active');

  // ✅ Live backend tab refresh
  try {
    if (tab === 'logs') {
      adminRefreshBackendUrlUI();
      renderAdminOnlineUsers();
      renderAdminLog();
      liveRequestAdminRefresh();
    }
    if (tab === 'accounts') {
      adminRefreshServerAccounts();
    }
  } catch (_) {
    // ignore
  }
}

// =========================
// Admin: Server Accounts (Render backend)
// =========================
async function adminRefreshServerAccounts() {
  const box = document.getElementById('admin-server-accounts-list');
  const status = document.getElementById('admin-account-status');

  if (!box) return;

  if (session?.role !== 'admin') {
    box.innerHTML = '<div class="admin-help">Admin only.</div>';
    if (status) status.textContent = 'Admin only.';
    return;
  }

  if (!liveIsEnabled()) {
    box.innerHTML = '<div class="admin-help">Backend URL not set.</div>';
    if (status) status.textContent = 'Backend: URL not set.';
    return;
  }

  if (!liveAuthToken) {
    box.innerHTML = '<div class="admin-help">Login to backend required (no token).</div>';
    if (status) status.textContent = 'Backend: not authenticated (login required).';
    return;
  }

  box.innerHTML = '<div class="admin-help">Loading…</div>';
  if (status) status.textContent = liveWsConnected ? 'Backend: connected.' : 'Backend: authenticated (loading accounts)…';

  try {
    const json = await liveApiFetch('/api/accounts', { method: 'GET' });
    const accounts = Array.isArray(json?.accounts) ? json.accounts : (Array.isArray(json) ? json : []);

    if (accounts.length === 0) {
      box.innerHTML = '<div class="admin-help">No server accounts yet.</div>';
      if (status) status.textContent = 'Server accounts: 0';
      return;
    }

    box.innerHTML = accounts.map(a => {
      const u = escapeHTML(a.username || 'user');
      const r = escapeHTML(a.role || 'user');
      const created = a.createdAt ? new Date(a.createdAt).toLocaleString() : '';
      return `
        <div class="admin-list-item">
          <div class="admin-list-left">
            <div class="admin-list-title">${u}</div>
            <div class="admin-list-sub">Role: ${r}${created ? (' • Created: ' + escapeHTML(created)) : ''}</div>
          </div>
          <div class="admin-list-right"><span class="admin-pill">${r}</span></div>
        </div>
      `;
    }).join('');

    if (status) status.textContent = `Server accounts: ${accounts.length}`;
  } catch (err) {
    console.warn(err);
    box.innerHTML = `<div class="admin-help">Failed to load accounts. ${escapeHTML(String(err?.message || err))}</div>`;
    if (status) status.textContent = 'Failed to load server accounts.';
  }
}

async function adminCreateAccountServer() {
  const status = document.getElementById('admin-account-status');

  if (session?.role !== 'admin') {
    alert('Admin only.');
    return;
  }

  if (!liveIsEnabled()) {
    alert('Backend URL not set. Set it in Admin → Online & Logs (Backend URL), or set window.PADAYON_BACKEND_URL in index.html.');
    return;
  }

  if (!liveAuthToken) {
    alert('Backend login required (no token). Login again while backend is configured.');
    return;
  }

  const u = String(document.getElementById('admin-create-username')?.value || '').trim();
  const p = String(document.getElementById('admin-create-password')?.value || '');
  const r = String(document.getElementById('admin-create-role')?.value || 'user');

  if (!u || !p) {
    alert('Enter username and password.');
    return;
  }

  try {
    if (status) status.textContent = 'Creating…';
    await liveApiFetch('/api/accounts', {
      method: 'POST',
      body: { username: u, password: p, role: (r === 'admin' ? 'admin' : 'user') },
    });

    // Clear password
    const pw = document.getElementById('admin-create-password');
    if (pw) pw.value = '';

    if (status) status.textContent = `Created account: ${u}`;
    await adminRefreshServerAccounts();
  } catch (err) {
    console.warn(err);
    if (status) status.textContent = 'Create failed: ' + String(err?.message || err);
    alert('Create failed: ' + String(err?.message || err));
  }
}

function setAdminCreateType(type) {
  adminCreateType = type;

  // highlight type cards
  const cards = {
    quiz: 'admin-type-quiz',
    notes: 'admin-type-notes',
    folder: 'admin-type-folder',
  };

  Object.entries(cards).forEach(([t, id]) => {
    document.getElementById(id)?.classList.toggle('active', t === type);
    // dot
    const dot = document.querySelector(`#${id} .admin-type-dot`);
    if (dot) dot.classList.toggle('on', t === type);
  });

  // show/hide panels
  document.getElementById('admin-panel-quiz')?.classList.toggle('hidden', type !== 'quiz');
  document.getElementById('admin-panel-notes')?.classList.toggle('hidden', type !== 'notes');
  document.getElementById('admin-panel-folder')?.classList.toggle('hidden', type !== 'folder');

  // refresh lists for the active panel
  adminRefreshAll();
}

function getAdminTargetPath() {
  return normalizePath(document.getElementById('admin-target-path')?.value || '');
}

function setAdminTargetPath(path) {
  const el = document.getElementById('admin-target-path');
  const p = normalizePath(path);
  if (el) el.value = p;

  // If an admin selects/types a nested path that doesn't exist yet,
  // create the folder chain so it stays inside the correct category.
  // (No-op if it already exists.)
  if (p) {
    const changed = ensureFolder(p);
    if (changed) touchLibrary();
  }
}

function adminComputePathVisibility(path) {
  const p = normalizePath(path);
  const pl = p.toLowerCase();
  if (!p) return ['ROOT (not linked to a menu)'];
  if (isGlobalFolder(p)) return ['GLOBAL (shows in all quiz browsers & notes roots)'];

  const vis = [];
  const add = (prefix, label) => {
    if (pl.startsWith(prefix.toLowerCase())) vis.push(label);
  };

  add('UNDERGROUNDS/FORMULAS', 'UNDERGROUNDS → FORMULAS (Notes)');
  add('UNDERGROUNDS/CALCULATOR TECHNIQUES', 'UNDERGROUNDS → CALCULATOR TECHNIQUES (Notes)');
  add('UNDERGROUNDS/PROBLEM EXERCISES', 'UNDERGROUNDS → PROBLEM EXERCISES (Quiz Sets)');

  // EXHALE FILE (separate roots)
  add('EXHALE FILE/NOTES', 'EXHALE FILE → NOTES (PDF Notes)');
  add('EXHALE FILE/PRACTICE QUIZ', 'EXHALE FILE → PRACTICE QUIZ (Quiz Sets)');
  add('EXHALE FILE/EXAM', 'EXHALE FILE → EXAM (Quiz Sets)');

  // PAWER-LAYN FILE (separate roots)
  add('PAWER-LAYN FILE/NOTES', 'PAWER-LAYN FILE → NOTES (PDF Notes)');
  add('PAWER-LAYN FILE/PRACTICE QUIZ', 'PAWER-LAYN FILE → PRACTICE QUIZ (Quiz Sets)');
  add('PAWER-LAYN FILE/EXAM', 'PAWER-LAYN FILE → EXAM (Quiz Sets)');

  // T-AY-PI custom quiz-set browser
  add('T-AY-PI', 'T-AY-PI (Quiz Sets)');

  if (vis.length === 0) {
    vis.push('Custom path (not linked in UI yet)');
  }
  return vis;
}

// Admin "Quick Pick" should include categories + subcategories, and stay up-to-date
// when new folders are created.
const ADMIN_QUICK_PICK_PRESETS = [
  'GLOBAL',

  // Main menu categories
  'UNDERGROUNDS',
  'T-AY-PI',
  'EXHALE FILE',
  'PAWER-LAYN FILE',

  // UnderGrounds (notes + quiz sets)
  'UNDERGROUNDS/FORMULAS',
  'UNDERGROUNDS/CALCULATOR TECHNIQUES',
  'UNDERGROUNDS/PROBLEM EXERCISES',
  'UNDERGROUNDS/TERMS & OBJECTIVES',

  // T-AY-PI (notes + quiz sets)
  'T-AY-PI/MATHEMATICS',
  'T-AY-PI/ESAS',
  'T-AY-PI/EE',
  'T-AY-PI/OTHERS',

  // EXHALE FILES (notes + quiz sets)
  'EXHALE FILE/NOTES',
  'EXHALE FILE/PRACTICE QUIZ',
  'EXHALE FILE/EXAM',

  // PAWER-LAYN FILES (notes + quiz sets)
  'PAWER-LAYN FILE/NOTES',
  'PAWER-LAYN FILE/PRACTICE QUIZ',
  'PAWER-LAYN FILE/EXAM',
];

// Extract every built-in category/subcategory path already linked in the UI.
// This keeps the Quick Pick complete without having to manually maintain a giant list.
let _cachedUiFolderPaths = null;
function adminCollectUiFolderPaths() {
  if (_cachedUiFolderPaths) return _cachedUiFolderPaths.slice();

  const out = new Set();
  try {
    const nodes = document.querySelectorAll('[onclick]');
    const re = /(openCustomQuizBrowser|openNotesFolder)\s*\(\s*(['"`])([^'"`]+?)\2/g;

    nodes.forEach(el => {
      const code = String(el.getAttribute('onclick') || '');
      let m;
      while ((m = re.exec(code))) {
        const p = normalizePath(m[3]);
        if (p) out.add(p);
      }
    });
  } catch (e) {
    // ignore
  }

  _cachedUiFolderPaths = Array.from(out);
  return _cachedUiFolderPaths.slice();
}

function expandWithAncestors(paths) {
  const out = new Set();
  for (const p of paths || []) {
    const n = normalizePath(p);
    if (!n) continue;
    const parts = n.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      out.add(parts.slice(0, i).join('/'));
    }
  }
  return Array.from(out);
}

function uniquePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths || []) {
    const n = normalizePath(p);
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function adminGetQuickPickPaths() {
  const presets = ADMIN_QUICK_PICK_PRESETS.map(normalizePath).filter(Boolean);
  const fromUI = adminCollectUiFolderPaths().map(normalizePath).filter(Boolean);
  const fromLibrary = getAllFolderPaths(library).map(normalizePath).filter(Boolean);

  // Include category + subcategory levels automatically by adding all ancestor paths.
  return uniquePaths(expandWithAncestors([...presets, ...fromUI, ...fromLibrary]));
}

function adminRefreshQuickPickOptions() {
  const sel = document.getElementById('admin-quick-pick');
  if (!sel) return;

  const current = getAdminTargetPath() || '';
  const all = adminGetQuickPickPaths();

  // Prefer GLOBAL at the top; keep everything else alphabetically.
  const sorted = all.slice().sort((a, b) => {
    if (a === 'GLOBAL') return -1;
    if (b === 'GLOBAL') return 1;
    return a.localeCompare(b);
  });

  sel.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Quick pick: choose a folder…';
  sel.appendChild(placeholder);

  for (const p of sorted) {
    const opt = document.createElement('option');
    opt.value = p;
    const depth = p.split('/').filter(Boolean).length;
    const indent = '\u00A0\u00A0'.repeat(Math.max(0, depth - 1));
    opt.textContent = indent + p;
    sel.appendChild(opt);
  }

  // Restore selection if possible.
  if (current && Array.from(sel.options).some(o => samePath(o.value, current))) {
    sel.value = current;
  } else {
    sel.value = '';
  }
}

function adminUpdatePathHelpers() {
  const p = getAdminTargetPath();

  const normEl = document.getElementById('admin-path-normalized');
  if (normEl) normEl.textContent = p || '(root)';

  const visEl = document.getElementById('admin-path-visibility');
  if (visEl) visEl.textContent = adminComputePathVisibility(p).join(' • ');
}

async function adminCopyTargetPath() {
  const p = getAdminTargetPath();
  if (!p) {
    alert('Target path is empty.');
    return;
  }

  // Clipboard API needs secure context; fall back to textarea copy.
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(p);
    } else {
      const ta = document.createElement('textarea');
      ta.value = p;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    alert('Copied target path.');
  } catch (err) {
    console.warn(err);
    alert('Copy failed. You can manually select and copy the Target path input.');
  }
}

function adminPreviewQuizSets() {
  const p = getAdminTargetPath() || '';
  openCustomQuizBrowser(p, 'admin-overlay', 'PREVIEW QUIZ SETS');
}

function adminPreviewPdfs() {
  const p = getAdminTargetPath() || '';
  openNotesFolder(p, 'PREVIEW PDFs', 'admin-overlay', 'all');
}

function adminRefreshAll() {
  adminRefreshQuickPickOptions();
  adminUpdatePathHelpers();
  adminRefreshFolderList();
  adminRefreshQuizSetSelect();
  adminRefreshPdfList();
  adminUpdateQuestionCount();
  adminRefreshQuestionList();
}

function adminRefreshFolderList() {
  const box = document.getElementById('admin-folder-list');
  if (!box) return;

  const base = getAdminTargetPath();
  const children = getImmediateChildFolders(base);

  if (children.length === 0) {
    box.innerHTML = '<div class="admin-list-item"><div class="admin-list-left"><div class="admin-list-title">No subfolders</div><div class="admin-list-sub">Create one above, or type a deeper Target path.</div></div></div>';
    return;
  }

  box.innerHTML = children.map(f => {
    const sets = (library.quizSets || []).filter(s => isUnderPath(s.folder, f.path) && !isGlobalFolder(s.folder)).length;
    const pdfs = (library.pdfs || []).filter(p => isUnderPath(p.folder, f.path) && !isGlobalFolder(p.folder)).length;
    const meta = `${sets} set${sets === 1 ? '' : 's'} • ${pdfs} pdf${pdfs === 1 ? '' : 's'}`;
    return `
      <div class="admin-list-item" onclick="setAdminTargetPath('${f.path.replace(/'/g, "\\'")}'); adminRefreshAll();">
        <div class="admin-list-left">
          <div class="admin-list-title">📁 ${escapeHTML(f.name)}</div>
          <div class="admin-list-sub">${escapeHTML(f.path)} • ${escapeHTML(meta)}</div>
        </div>
        <div class="admin-list-right"><span class="admin-pill">OPEN</span></div>
      </div>
    `;
  }).join('');
}

function adminRefreshQuizSetSelect() {
  const sel = document.getElementById('admin-quiz-select');
  if (!sel) return;

  const current = adminSelectedQuizSetId;

  // rebuild options
  sel.innerHTML = '<option value="">-- Select existing set --</option>';
  library.quizSets
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.title}  [${s.folder}]`;
      sel.appendChild(opt);
    });

  if (current) sel.value = current;
}

function adminGetSelectedSet() {
  if (!adminSelectedQuizSetId) return null;
  return library.quizSets.find(s => s.id === adminSelectedQuizSetId) || null;
}

function adminUpdateQuestionCount() {
  const countEl = document.getElementById('admin-q-count');
  if (!countEl) return;

  const set = adminGetSelectedSet();
  const n = set?.questions?.length || 0;
  countEl.textContent = String(n);
}

function adminSelectQuizSet(setId) {
  adminSelectedQuizSetId = setId || '';
  const sel = document.getElementById('admin-quiz-select');
  if (sel) sel.value = adminSelectedQuizSetId;
  adminClearQuestionBuilder();
  adminUpdateQuestionCount();
  adminRefreshQuestionList();
}

function adminSetQuestionBuilderMode(isEditing) {
  const addBtn = document.getElementById('admin-q-add-btn');
  const clearBtn = document.getElementById('admin-q-clear-btn');
  const status = document.getElementById('admin-q-edit-status');
  const set = adminGetSelectedSet();

  if (addBtn) addBtn.textContent = isEditing ? 'SAVE QUESTION' : 'ADD QUESTION';
  if (clearBtn) clearBtn.textContent = isEditing ? 'CANCEL EDIT' : 'CLEAR';

  if (status) {
    if (!set) status.textContent = 'Select a quiz set first.';
    else if (isEditing && set.questions?.[adminEditingQuestionIndex]) status.textContent = `Editing question #${adminEditingQuestionIndex + 1}`;
    else status.textContent = 'Add a new question to the selected set.';
  }
}

function adminNormalizeQuestionIds(set) {
  if (!set || !Array.isArray(set.questions)) return;
  set.questions = set.questions.map((q, index) => ({
    ...q,
    id: index + 1,
    ans: String(q?.options?.[q?.key] || q?.ans || ''),
  }));
}

function adminQuestionSummary(q) {
  const text = String(q?.q || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(empty question)';
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

function adminFillQuestionBuilder(question, index) {
  const q = question || {};
  const opts = q.options || {};

  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value == null ? '' : String(value);
  };

  setValue('admin-q-topic', q.topic || '');
  setValue('admin-q-text', q.q || '');
  setValue('admin-q-a', opts.a || '');
  setValue('admin-q-b', opts.b || '');
  setValue('admin-q-c', opts.c || '');
  setValue('admin-q-d', opts.d || '');
  setValue('admin-q-soln', q.soln || '');
  setValue('admin-q-caltech', q.caltech || '');
  setValue('admin-q-correct', q.key || 'a');

  adminEditingQuestionIndex = Number(index);
  adminSetQuestionBuilderMode(true);
}

function adminRefreshQuestionList() {
  const box = document.getElementById('admin-question-list');
  if (!box) return;

  const set = adminGetSelectedSet();
  if (!set) {
    box.innerHTML = '<div class="admin-help">Select a quiz set to manage questions.</div>';
    adminSetQuestionBuilderMode(false);
    return;
  }

  const items = Array.isArray(set.questions) ? set.questions : [];
  if (items.length === 0) {
    box.innerHTML = '<div class="admin-help">No questions in this set yet.</div>';
    adminSetQuestionBuilderMode(adminEditingQuestionIndex >= 0);
    return;
  }

  box.innerHTML = items.map((q, index) => {
    const topic = q?.topic ? `<span class="admin-pill">${escapeHTML(q.topic)}</span>` : '';
    const correct = escapeHTML(String(q?.key || '').toUpperCase());
    const summary = escapeHTML(adminQuestionSummary(q));

    return `
      <div class="admin-list-item">
        <div class="admin-list-left">
          <div class="admin-list-title">#${index + 1} ${summary}</div>
          <div class="admin-list-sub flex flex-wrap gap-2 items-center">
            ${topic}
            <span class="admin-mono">Correct: ${correct || '-'}</span>
          </div>
        </div>
        <div class="admin-list-right" style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="admin-mini-btn" type="button" onclick="adminEditQuestion(${index})">EDIT</button>
          <button class="admin-mini-btn" type="button" onclick="adminDuplicateQuestion(${index})">DUPLICATE</button>
          <button class="admin-mini-btn" type="button" style="border-color: rgba(255, 0, 85, 0.55);" onclick="adminDeleteQuestion(${index})">DELETE</button>
        </div>
      </div>
    `;
  }).join('');

  adminSetQuestionBuilderMode(adminEditingQuestionIndex >= 0);
}

function adminEditQuestion(index) {
  const set = adminGetSelectedSet();
  const question = set?.questions?.[index];
  if (!question) return;
  adminFillQuestionBuilder(question, index);
}

function adminDuplicateQuestion(index) {
  const set = adminGetSelectedSet();
  const question = set?.questions?.[index];
  if (!question) return;

  const copy = {
    ...question,
    options: { ...(question.options || {}) },
  };

  const items = Array.isArray(set.questions) ? set.questions.slice() : [];
  items.splice(index + 1, 0, copy);
  set.questions = items;
  adminNormalizeQuestionIds(set);
  set.updatedAt = nowISO();
  touchLibrary();

  adminUpdateQuestionCount();
  adminRefreshQuestionList();
}

function adminDeleteQuestion(index) {
  const set = adminGetSelectedSet();
  const question = set?.questions?.[index];
  if (!question) return;

  if (!confirm(`Delete question #${index + 1}?`)) return;

  set.questions = (set.questions || []).filter((_, i) => i !== index);
  adminNormalizeQuestionIds(set);
  set.updatedAt = nowISO();
  touchLibrary();

  if (adminEditingQuestionIndex === index) {
    adminClearQuestionBuilder();
  } else if (adminEditingQuestionIndex > index) {
    adminEditingQuestionIndex -= 1;
  }

  adminUpdateQuestionCount();
  adminRefreshQuestionList();
}

function adminCreateQuizSet() {
  const titleEl = document.getElementById('admin-quiz-title');
  const title = String(titleEl?.value || '').trim();
  if (!title) {
    alert('Enter a quiz set title.');
    return;
  }

  const folder = getAdminTargetPath() || 'GLOBAL';
  ensureFolder(folder);

  const set = {
    id: uid('qs'),
    title,
    folder,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    questions: [],
  };

  library.quizSets.push(set);
  touchLibrary();

  if (titleEl) titleEl.value = '';

  adminRefreshQuizSetSelect();
  adminSelectQuizSet(set.id);

  alert(`Quiz set created: ${set.title}  [${set.folder}]`);
}

function adminMoveSelectedQuizSet() {
  const set = adminGetSelectedSet();
  if (!set) {
    alert('Select a quiz set first.');
    return;
  }

  const movePathEl = document.getElementById('admin-quiz-move-path');
  const raw = String(movePathEl?.value || '').trim();
  const target = raw ? normalizePath(raw) : getAdminTargetPath();

  if (!target) {
    alert('Enter a folder path (or set Target folder path).');
    return;
  }

  ensureFolder(target);

  set.folder = target;
  set.updatedAt = nowISO();
  touchLibrary();

  if (movePathEl) movePathEl.value = '';
  adminRefreshQuizSetSelect();
  adminSelectQuizSet(set.id);

  alert('Moved quiz set.');
}

function adminDeleteSelectedQuizSet() {
  const set = adminGetSelectedSet();
  if (!set) {
    alert('Select a quiz set first.');
    return;
  }

  const alsoQuestions = !!document.getElementById('admin-quiz-delete-questions')?.checked;

  if (!confirm(`Delete selected quiz set: "${set.title}"?`)) return;

  if (alsoQuestions) {
    // remove entire set
    library.quizSets = library.quizSets.filter(s => s.id !== set.id);
  } else {
    // keep set, clear questions
    set.questions = [];
    set.updatedAt = nowISO();
  }

  touchLibrary();

  adminSelectedQuizSetId = '';
  adminClearQuestionBuilder();
  adminRefreshQuizSetSelect();
  adminUpdateQuestionCount();
  adminRefreshQuestionList();

  alert('Deleted.');
}

function adminExportSelectedQuizSet() {
  const set = adminGetSelectedSet();
  if (!set) {
    alert('Select a quiz set first.');
    return;
  }

  const payload = {
    format: 'PADAYON_QUIZSET_V1',
    title: set.title,
    folder: set.folder,
    exportedAt: nowISO(),
    questions: Array.isArray(set.questions) ? set.questions : [],
  };

  const safe = set.title.replace(/[^a-z0-9\-\_]+/gi, '_');
  downloadJSON(`${safe || 'quiz_set'}.json`, payload);
}

function sanitizeQuestion(q, nextId) {
  const topic = String(q.topic || '').trim();
  const text = String(q.q || q.question || '').trim();
  const opts = q.options || q.choices || {};

  const a = String(opts.a ?? opts.A ?? q.a ?? '').trim();
  const b = String(opts.b ?? opts.B ?? q.b ?? '').trim();
  const c = String(opts.c ?? opts.C ?? q.c ?? '').trim();
  const d = String(opts.d ?? opts.D ?? q.d ?? '').trim();

  const keyRaw = String(q.key || q.correct || '').trim().toLowerCase();
  const key = ['a', 'b', 'c', 'd'].includes(keyRaw) ? keyRaw : 'a';

  const options = { a, b, c, d };
  const ans = String(q.ans || options[key] || '').trim();

  return {
    id: Number.isFinite(q.id) ? q.id : nextId,
    topic: topic || 'Custom',
    q: text,
    options,
    key,
    ans,
    soln: String(q.soln || q.solution || '').trim(),
    caltech: q.caltech != null ? String(q.caltech) : null,
  };
}

async function adminImportQuestionsJson() {
  const set = adminGetSelectedSet();
  if (!set) {
    alert('Select a quiz set first.');
    return;
  }

  const fileEl = document.getElementById('admin-import-file');
  const file = fileEl?.files?.[0];
  if (!file) {
    alert('Choose a JSON file first.');
    return;
  }

  try {
    const text = await readFileAsText(file);
    const json = JSON.parse(text);

    let questions = [];
    if (Array.isArray(json)) questions = json;
    else if (json && Array.isArray(json.questions)) questions = json.questions;

    if (!Array.isArray(questions) || questions.length === 0) {
      alert('No questions found in JSON.');
      return;
    }

    const maxExistingId = (set.questions || []).reduce((m, q) => Math.max(m, Number(q.id) || 0), 0);
    let nextId = maxExistingId + 1;

    const sanitized = questions
      .map(q => sanitizeQuestion(q, nextId++))
      .filter(q => q.q);

    if (sanitized.length === 0) {
      alert('Questions imported, but all were empty after sanitizing.');
      return;
    }

    set.questions = Array.isArray(set.questions) ? set.questions.concat(sanitized) : sanitized;
    adminNormalizeQuestionIds(set);
    set.updatedAt = nowISO();
    touchLibrary();

    if (fileEl) fileEl.value = '';

    adminUpdateQuestionCount();
    adminRefreshQuestionList();
    alert(`Imported ${sanitized.length} question(s).`);
  } catch (err) {
    console.error(err);
    alert('Invalid JSON file.');
  }
}

function adminClearQuestionBuilder() {
  const ids = ['admin-q-topic', 'admin-q-text', 'admin-q-a', 'admin-q-b', 'admin-q-c', 'admin-q-d', 'admin-q-soln', 'admin-q-caltech'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const correct = document.getElementById('admin-q-correct');
  if (correct) correct.value = 'a';

  adminEditingQuestionIndex = -1;
  adminSetQuestionBuilderMode(false);
}

function adminAddQuestion() {
  const set = adminGetSelectedSet();
  if (!set) {
    alert('Select a quiz set first.');
    return;
  }

  const topic = String(document.getElementById('admin-q-topic')?.value || '').trim();
  const text = String(document.getElementById('admin-q-text')?.value || '').trim();
  const a = String(document.getElementById('admin-q-a')?.value || '').trim();
  const b = String(document.getElementById('admin-q-b')?.value || '').trim();
  const c = String(document.getElementById('admin-q-c')?.value || '').trim();
  const d = String(document.getElementById('admin-q-d')?.value || '').trim();
  const soln = String(document.getElementById('admin-q-soln')?.value || '').trim();
  const caltech = String(document.getElementById('admin-q-caltech')?.value || '').trim();
  const key = String(document.getElementById('admin-q-correct')?.value || 'a').toLowerCase();
  const resolvedKey = ['a', 'b', 'c', 'd'].includes(key) ? key : 'a';

  if (!text) {
    alert('Question text is required.');
    return;
  }
  if (!a || !b || !c || !d) {
    alert('Please fill Options A, B, C, and D.');
    return;
  }

  const q = {
    id: adminEditingQuestionIndex >= 0 ? adminEditingQuestionIndex + 1 : ((set.questions || []).length + 1),
    topic: topic || 'Custom',
    q: text,
    options: { a, b, c, d },
    key: resolvedKey,
    ans: { a, b, c, d }[resolvedKey] || a,
    soln,
    caltech: caltech || null,
  };

  if (!Array.isArray(set.questions)) set.questions = [];
  const wasEditing = adminEditingQuestionIndex >= 0 && !!set.questions[adminEditingQuestionIndex];

  if (wasEditing) {
    set.questions[adminEditingQuestionIndex] = q;
  } else {
    set.questions.push(q);
  }

  adminNormalizeQuestionIds(set);
  set.updatedAt = nowISO();
  touchLibrary();

  adminUpdateQuestionCount();
  adminRefreshQuestionList();
  adminClearQuestionBuilder();

  alert(wasEditing ? 'Question updated.' : 'Question added.');
}

function adminGetPdfKind() {
  const val = String(document.getElementById('admin-pdf-kind')?.value || 'notes').toLowerCase();
  return val === 'archive' ? 'archive' : 'notes';
}

async function adminUploadPdf(kind = 'notes') {
  const fileEl = document.getElementById('admin-pdf-file');
  const file = fileEl?.files?.[0];
  const urlEl = document.getElementById('admin-pdf-url');
  const rawUrl = String(urlEl?.value || '').trim();

  if (!file && !rawUrl) {
    alert('Choose a PDF file or paste a PDF URL/path first.');
    return;
  }

  const titleEl = document.getElementById('admin-pdf-title');
  const displayTitle = String(titleEl?.value || '').trim() || (file?.name || baseName(rawUrl) || 'PDF');

  const folder = getAdminTargetPath() || 'GLOBAL';
  ensureFolder(folder);

  const autoUrl = file ? ('assets/pdfs/' + encodeURIComponent(file.name)) : '';
  const safeSrc = encodeURI(rawUrl || autoUrl);

  library.pdfs.push({
    id: uid('pdf'),
    title: displayTitle,
    folder,
    kind,
    src: safeSrc,
    createdAt: nowISO(),
  });

  touchLibrary();

  if (fileEl) fileEl.value = '';
  if (titleEl) titleEl.value = '';
  if (urlEl) urlEl.value = '';

  adminRefreshPdfList();

  if (rawUrl) {
    alert('PDF URL attached. Library now stores only the URL/path.');
  } else {
    alert(`PDF entry saved as URL only:\n${safeSrc}\n\nUpload the real PDF file to that same path in your repo or hosting.`);
  }
}

function adminAttachPdfUrl(kind = 'notes') {
  const urlEl = document.getElementById('admin-pdf-url');
  const rawUrl = String(urlEl?.value || '').trim();
  if (!rawUrl) {
    alert('Paste a PDF URL/path first.');
    return;
  }

  const titleEl = document.getElementById('admin-pdf-title');
  const displayTitle = String(titleEl?.value || '').trim() || baseName(rawUrl) || 'PDF';

  const folder = getAdminTargetPath() || 'GLOBAL';
  ensureFolder(folder);

  const safeSrc = encodeURI(rawUrl);

  library.pdfs.push({
    id: uid('pdf'),
    title: displayTitle,
    folder,
    kind,
    src: safeSrc,
    createdAt: nowISO(),
  });

  const saved = touchLibrary();

  if (urlEl) urlEl.value = '';
  if (titleEl) titleEl.value = '';

  adminRefreshPdfList();

  if (!saved) {
    alert('PDF URL attached, but browser storage is blocked/full.\n\n👉 To persist/share: use Backup → Export library.json.');
  } else {
    alert('PDF URL attached. (Export library.json in Backup to share)');
  }
}

function adminRefreshPdfList() {
  const list = document.getElementById('admin-pdf-list');
  if (!list) return;

  const folder = getAdminTargetPath();

  // In admin we show PDFs *under* the target path (recursive), so it's easy
  // to confirm uploads even when you attach them in subfolders.
  // If target path is empty (root), show GLOBAL PDFs.
  const items = (library.pdfs || [])
    .filter(p => {
      const pf = normalizePath(p.folder || '');
      if (!folder) return isGlobalFolder(pf) || !pf;
      return isUnderPath(pf, folder);
    })
    .slice()
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

  if (items.length === 0) {
    list.innerHTML = '<div class="admin-help">No PDFs attached.</div>';
    return;
  }

  list.innerHTML = '';
  items.forEach(p => {
    const row = document.createElement('div');
    row.className = 'admin-list-item';
    row.innerHTML = `
      <div>
        <div class="admin-list-title">${escapeHTML(p.title)}</div>
        <div class="admin-list-sub">${escapeHTML(p.kind)} • ${escapeHTML(p.folder)}</div>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <button class="admin-mini-btn" type="button">VIEW</button>
        <button class="admin-mini-btn" type="button" style="border-color: rgba(255, 0, 85, 0.55);">DELETE</button>
      </div>
    `;

    const [viewBtn, delBtn] = row.querySelectorAll('button');

    viewBtn.addEventListener('click', () => {
      // menu overlays are behind admin (z-index). Hide admin while previewing.
      openPdfOverlay(p.id, 'admin-overlay');
    });

    delBtn.addEventListener('click', () => {
      if (!confirm(`Delete PDF: "${p.title}"?`)) return;
      library.pdfs = library.pdfs.filter(x => x.id !== p.id);
      touchLibrary();
      adminRefreshPdfList();
    });

    list.appendChild(row);
  });
}

function adminCreateFolder() {
  const name = String(document.getElementById('admin-folder-name')?.value || '').trim();
  if (!name) {
    alert('Enter folder name.');
    return;
  }

  const parent = getAdminTargetPath();

  // If the user pasted a full path starting with a known root category,
  // treat it as an absolute path (avoid accidentally creating
  // "GLOBAL/UNDERGROUNDS/..." etc).
  const roots = ['GLOBAL', 'UNDERGROUNDS', 'T-AY-PI', 'EXHALE FILE', 'PAWER-LAYN FILE'];
  const nameNorm = normalizePath(name);
  const top = (nameNorm.split('/')[0] || '');
  const isAbsolute = roots.some(r => samePath(top, r));

  const full = normalizePath(isAbsolute ? nameNorm : (parent ? `${parent}/${name}` : name));

  const changed = ensureFolder(full);
  if (changed) touchLibrary();

  document.getElementById('admin-folder-name').value = '';

  adminRefreshAll();

  alert(changed ? `Folder created: ${full}` : `Folder already exists: ${full}`);
}

function adminOpenTarget() {
  const p = getAdminTargetPath();
  alert(`Target folder path:\n${p || '(root)'}`);
}

function adminRenameFolder() {
  const newName = String(document.getElementById('admin-folder-rename')?.value || '').trim();
  if (!newName) {
    alert('Enter new folder name.');
    return;
  }

  const from = getAdminTargetPath();
  if (!from) {
    alert('Set Target folder path to the folder you want to rename.');
    return;
  }

  const parent = parentPath(from);
  const to = normalizePath(parent ? `${parent}/${newName}` : newName);

  adminMoveFolderInternal(from, to);

  document.getElementById('admin-folder-rename').value = '';
  setAdminTargetPath(to);

  adminRefreshAll();

  alert('Folder renamed.');
}

function adminMoveFolder() {
  const newParent = normalizePath(String(document.getElementById('admin-folder-move-parent')?.value || '').trim());
  const from = getAdminTargetPath();

  if (!from) {
    alert('Set Target folder path to the folder you want to move.');
    return;
  }
  if (!newParent) {
    alert('Enter a new parent path.');
    return;
  }

  const to = normalizePath(`${newParent}/${baseName(from)}`);
  adminMoveFolderInternal(from, to);

  document.getElementById('admin-folder-move-parent').value = '';
  setAdminTargetPath(to);

  adminRefreshAll();

  alert('Folder moved.');
}

function adminMoveFolderInternal(from, to) {
  const fromN = normalizePath(from);
  const toN = normalizePath(to);

  // ensure destination folder and parent
  ensureFolder(parentPath(toN));
  ensureFolder(toN);

  // Update folders list (replace prefix)
  library.folders = library.folders
    .map(f => {
      if (isUnderPath(f.path, fromN)) {
        const suffix = normalizePath(f.path).slice(normalizePath(fromN).length);
        const cleanSuffix = suffix.startsWith('/') ? suffix : (suffix ? '/' + suffix : '');
        return { ...f, path: normalizePath(toN + cleanSuffix) };
      }
      return f;
    })
    .filter((f, idx, arr) => arr.findIndex(x => samePath(x.path, f.path)) === idx);

  // Update quiz sets
  library.quizSets.forEach(s => {
    if (isUnderPath(s.folder, fromN)) {
      const suffix = normalizePath(s.folder).slice(normalizePath(fromN).length);
      const cleanSuffix = suffix.startsWith('/') ? suffix : (suffix ? '/' + suffix : '');
      s.folder = normalizePath(toN + cleanSuffix);
      s.updatedAt = nowISO();
    }
  });

  // Update pdfs
  library.pdfs.forEach(p => {
    if (isUnderPath(p.folder, fromN)) {
      const suffix = normalizePath(p.folder).slice(normalizePath(fromN).length);
      const cleanSuffix = suffix.startsWith('/') ? suffix : (suffix ? '/' + suffix : '');
      p.folder = normalizePath(toN + cleanSuffix);
    }
  });

  touchLibrary();
}

function adminDeleteFolder() {
  const target = getAdminTargetPath();
  if (!target) {
    alert('Set Target folder path to the folder you want to delete.');
    return;
  }

  const alsoDelete = !!document.getElementById('admin-folder-delete-contents')?.checked;

  if (!confirm(`Delete folder (recursive):\n${target}\n\nThis will affect subfolders and content inside.`)) return;

  const parent = parentPath(target);

  // Remove folder entries under target
  library.folders = library.folders.filter(f => !isUnderPath(f.path, target));

  if (alsoDelete) {
    library.quizSets = library.quizSets.filter(s => !isUnderPath(s.folder, target));
    library.pdfs = library.pdfs.filter(p => !isUnderPath(p.folder, target));
  } else {
    // move content to parent folder
    library.quizSets.forEach(s => {
      if (isUnderPath(s.folder, target)) s.folder = parent;
    });
    library.pdfs.forEach(p => {
      if (isUnderPath(p.folder, target)) p.folder = parent;
    });
  }

  touchLibrary();
  adminRefreshAll();

  alert('Folder deleted.');
}

function adminHowItWorks() {
  alert(
    'How folders work:\n\n' +
    '• Target folder path = where quiz sets/PDFs are attached.\n' +
    '• Archive Folder tool edits the folder in Target folder path.\n' +
    '• Export library.json in Backup tab and COMMIT it to GitHub so everyone can see the updates.'
  );
}

async function importLibraryFromFile(file, { statusEl = null } = {}) {
  if (!file) return false;
  const text = await readFileAsText(file);
  const json = JSON.parse(text);

  library = normalizeIncomingLibrary(json);
  libraryLoadState = { ok: true, source: 'import', error: null };

  // Persist to local cache so other tabs (user view) can see it instantly.
  const persisted = touchLibrary();

  updateAdminLibraryStatus();
  showLibraryHintIfNeeded();
  refreshUiAfterLibraryChange();

  if (statusEl) {
    statusEl.textContent = persisted
      ? `Imported ${file.name} (saved to cache).`
      : `Imported ${file.name} (in-memory only; cache/storage may be full).`;
  }

  return persisted;
}

async function adminQuickImportLibrary() {
  if (session.role !== 'admin') {
    alert('Admin only.');
    return;
  }

  const fileEl = document.getElementById('admin-quick-import-file');
  const file = fileEl?.files?.[0];
  if (!file) {
    alert('Choose a library.json file first.');
    return;
  }

  try {
    const persisted = await importLibraryFromFile(file);
    alert(persisted
      ? 'Library imported and saved to cache.'
      : 'Library imported, but could not save to cache (storage might be full).'
    );
  } catch (err) {
    console.error(err);
    alert('Invalid library.json');
  } finally {
    // allow importing the same file again
    if (fileEl) fileEl.value = '';
  }
}

// USER quick import (landing page button)
// Allows non-admin users to load a library.json update/backup locally.
function userQuickImportLibrary() {
  const fileEl = document.getElementById('user-import-file');
  if (!fileEl) {
    alert('Import control not found.');
    return;
  }

  // Reset so the same file can be selected again.
  fileEl.value = '';

  fileEl.onchange = async () => {
    const file = fileEl.files?.[0];
    if (!file) return;

    const ok = confirm(
      'Import library.json?\n\nThis will replace your current local quiz/notes library on this device.'
    );
    if (!ok) {
      fileEl.value = '';
      return;
    }

    try {
      const persisted = await importLibraryFromFile(file);
      alert(persisted
        ? 'Update imported and saved locally.'
        : 'Update imported, but could not save locally (storage may be full).'
      );
    } catch (err) {
      console.error(err);
      alert('Invalid library.json');
    } finally {
      fileEl.value = '';
    }
  };

  fileEl.click();
}

async function adminImportLibrary() {
  const fileEl = document.getElementById('admin-backup-import-file');
  const status = document.getElementById('admin-backup-status');
  const file = fileEl?.files?.[0];
  if (!file) {
    alert('Choose a library.json file first.');
    return;
  }

  try {
    const persisted = await importLibraryFromFile(file, { statusEl: status });
    alert(persisted
      ? 'Imported library.json and saved to cache. Export + commit to GitHub to share with friends.'
      : 'Imported library.json, but could not save to cache (storage might be full). You can still Export + commit to GitHub.'
    );
  } catch (err) {
    console.error(err);
    alert('Invalid library.json');
  } finally {
    if (fileEl) fileEl.value = '';
  }
}

function adminExportLibrary() {
  // Update timestamps
  touchLibrary();
  const payload = { ...library, updatedAt: library.updatedAt || nowISO() };
  downloadJSON(LIBRARY_FILENAME, payload);
}

function adminExportLibraryJS() {
  // Update timestamps
  touchLibrary();
  const payload = { ...library, updatedAt: library.updatedAt || nowISO() };
  const js = `// Auto-generated by PADAYON Admin\n// Offline fallback for file:// mode (fetching library.json is blocked by the browser).\nwindow.${LIBRARY_GLOBAL_VAR} = ${JSON.stringify(payload, null, 2)};\n`;
  downloadText(LIBRARY_JS_FILENAME, js, 'application/javascript');
}

function adminSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const results = [];

  // folders
  library.folders.forEach(f => {
    if (f.path.toLowerCase().includes(q)) {
      results.push({ type: 'folder', label: f.path, value: f.path });
    }
  });

  // sets
  library.quizSets.forEach(s => {
    const hay = `${s.title} ${s.folder}`.toLowerCase();
    if (hay.includes(q)) {
      results.push({ type: 'quiz', label: s.title, sub: s.folder, value: s.id });
    }
  });

  // pdfs
  library.pdfs.forEach(p => {
    const hay = `${p.title} ${p.folder}`.toLowerCase();
    if (hay.includes(q)) {
      results.push({ type: 'pdf', label: p.title, sub: p.folder, value: p.id });
    }
  });

  return results.slice(0, 25);
}

function adminRenderSearchResults(query) {
  const box = document.getElementById('admin-search-results');
  if (!box) return;

  const q = String(query || '').trim();
  if (!q) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  const results = adminSearch(q);
  if (results.length === 0) {
    box.classList.remove('hidden');
    box.innerHTML = '<div class="admin-help" style="padding:12px;">No results.</div>';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = '';

  results.forEach(r => {
    const row = document.createElement('div');
    row.className = 'admin-search-item';

    row.innerHTML = `
      <div>
        <div class="admin-search-label">${escapeHTML(r.label)}</div>
        ${r.sub ? `<div class="admin-search-type">${escapeHTML(r.sub)}</div>` : `<div class="admin-search-type">${escapeHTML(r.type.toUpperCase())}</div>`}
      </div>
      <div class="admin-search-type">${escapeHTML(r.type.toUpperCase())}</div>
    `;

    row.addEventListener('click', () => {
      // act on click
      if (r.type === 'folder') {
        setAdminTargetPath(r.value);
        setAdminCreateType('quiz');
        adminRefreshAll();
      } else if (r.type === 'quiz') {
        // select set
        const set = library.quizSets.find(s => s.id === r.value);
        if (set) {
          setAdminTargetPath(set.folder);
          setAdminCreateType('quiz');
          adminRefreshAll();
          adminSelectQuizSet(set.id);
        }
      } else if (r.type === 'pdf') {
        const pdf = getPdfById(r.value);
        if (pdf) {
          setAdminTargetPath(pdf.folder);
          setAdminCreateType('notes');
          adminRefreshAll();
        }
      }

      box.classList.add('hidden');
      box.innerHTML = '';

      const inp = document.getElementById('admin-search-input');
      if (inp) inp.value = '';
    });

    box.appendChild(row);
  });
}

function initAdminUI() {
  // Sidebar
  document.getElementById('admin-nav-content')?.addEventListener('click', () => setAdminTab('content'));
  document.getElementById('admin-nav-accounts')?.addEventListener('click', () => setAdminTab('accounts'));
  document.getElementById('admin-nav-logs')?.addEventListener('click', () => setAdminTab('logs'));
  document.getElementById('admin-nav-backup')?.addEventListener('click', () => setAdminTab('backup'));

  document.getElementById('admin-close')?.addEventListener('click', () => {
    closeAdminPanel();
  });

  document.getElementById('admin-save')?.addEventListener('click', () => {
    adminSaveLibrary();
  });

  // Create type
  document.getElementById('admin-type-quiz')?.addEventListener('click', () => setAdminCreateType('quiz'));
  document.getElementById('admin-type-notes')?.addEventListener('click', () => setAdminCreateType('notes'));
  document.getElementById('admin-type-folder')?.addEventListener('click', () => setAdminCreateType('folder'));

  // Quick pick
  document.getElementById('admin-quick-pick')?.addEventListener('change', (e) => {
    const val = normalizePath(e.target.value || '');
    if (val) setAdminTargetPath(val);
    adminRefreshAll();
  });

  // Target path updates should refresh pdf list
  document.getElementById('admin-target-path')?.addEventListener('input', () => {
    adminUpdatePathHelpers();
    adminRefreshFolderList();
    // only refresh if notes tab visible
    if (adminCreateType === 'notes') adminRefreshPdfList();
    if (adminCreateType === 'quiz') adminRefreshQuestionList();
  });

  // Copy path
  document.getElementById('admin-copy-path')?.addEventListener('click', adminCopyTargetPath);
  document.getElementById('admin-preview-quiz')?.addEventListener('click', adminPreviewQuizSets);
  document.getElementById('admin-preview-pdfs')?.addEventListener('click', adminPreviewPdfs);

  // Quiz set create/select
  document.getElementById('admin-quiz-create-btn')?.addEventListener('click', adminCreateQuizSet);
  document.getElementById('admin-quiz-select')?.addEventListener('change', (e) => {
    adminSelectQuizSet(e.target.value);
  });

  // Move tools
  document.getElementById('admin-quiz-use-target-btn')?.addEventListener('click', () => {
    const move = document.getElementById('admin-quiz-move-path');
    if (move) move.value = getAdminTargetPath();
  });
  document.getElementById('admin-quiz-move-btn')?.addEventListener('click', adminMoveSelectedQuizSet);
  document.getElementById('admin-quiz-delete-btn')?.addEventListener('click', adminDeleteSelectedQuizSet);

  // Import/export
  document.getElementById('admin-import-btn')?.addEventListener('click', adminImportQuestionsJson);
  document.getElementById('admin-export-btn')?.addEventListener('click', adminExportSelectedQuizSet);

  // Question builder
  document.getElementById('admin-q-add-btn')?.addEventListener('click', adminAddQuestion);
  document.getElementById('admin-q-clear-btn')?.addEventListener('click', adminClearQuestionBuilder);

  // Notes
  document.getElementById('admin-pdf-upload-btn')?.addEventListener('click', () => adminUploadPdf(adminGetPdfKind()));
  document.getElementById('admin-pdf-attach-url-btn')?.addEventListener('click', () => adminAttachPdfUrl(adminGetPdfKind()));

  // Folder tools
  document.getElementById('admin-folder-create-btn')?.addEventListener('click', adminCreateFolder);
  document.getElementById('admin-folder-open-btn')?.addEventListener('click', adminOpenTarget);
  document.getElementById('admin-folder-rename-btn')?.addEventListener('click', adminRenameFolder);
  document.getElementById('admin-folder-move-btn')?.addEventListener('click', adminMoveFolder);
  document.getElementById('admin-folder-delete-btn')?.addEventListener('click', adminDeleteFolder);
  document.getElementById('admin-folder-how-btn')?.addEventListener('click', adminHowItWorks);
  document.getElementById('admin-folder-root-btn')?.addEventListener('click', () => setAdminTargetPath(''));

  // Search
  document.getElementById('admin-search-input')?.addEventListener('input', (e) => {
    adminRenderSearchResults(e.target.value);
  });
  document.getElementById('admin-search-clear')?.addEventListener('click', () => {
    const inp = document.getElementById('admin-search-input');
    if (inp) inp.value = '';
    adminRenderSearchResults('');
  });

  // Backup
  document.getElementById('admin-backup-export')?.addEventListener('click', adminExportLibrary);
  document.getElementById('admin-backup-export-js')?.addEventListener('click', adminExportLibraryJS);
  document.getElementById('admin-backup-import-btn')?.addEventListener('click', adminImportLibrary);

  // ✅ Live backend (accounts + online/logs)
  document.getElementById('admin-create-account-btn')?.addEventListener('click', adminCreateAccountServer);
  document.getElementById('admin-refresh-accounts-btn')?.addEventListener('click', adminRefreshServerAccounts);
  document.getElementById('admin-refresh-online-btn')?.addEventListener('click', () => {
    renderAdminOnlineUsers();
    renderAdminLog();
    liveRequestAdminRefresh();
  });
  document.getElementById('admin-clear-log-btn')?.addEventListener('click', () => {
    liveAdminLog = [];
    renderAdminLog();
  });

  // ✅ Backend URL setting (no need to edit index.html)
  document.getElementById('admin-backend-url-save-btn')?.addEventListener('click', adminSaveBackendUrlFromUI);
  document.getElementById('admin-backend-url-clear-btn')?.addEventListener('click', adminClearBackendUrlFromUI);
  document.getElementById('admin-backend-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      adminSaveBackendUrlFromUI();
    }
  });

  // Initial
  setAdminCreateType('quiz');
}

// Init admin UI once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  initAdminUI();
  try { adminRefreshBackendUrlUI(); } catch (_) {}
});

// =========================
// Small helpers
// =========================
function showLibraryHint(err) {
  // left for future
}


// =========================
// Debug aliases (optional)
// =========================
// Some users look for connectToBackend()/initLive() in the console.
// These are safe aliases to the live backend connector.
try {
  window.connectToBackend = function connectToBackend() {
    try { liveBackendUrl = getConfiguredBackendUrl(); } catch (_) {}
    try { liveAuthToken = getLiveToken(); } catch (_) {}
    try { liveConnect(); } catch (_) {}
  };
  window.initLive = window.connectToBackend;
} catch (_) {}
