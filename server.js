const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory session store: sessionKey -> { token, proshopRoot, expiresAt }
// Each visitor gets their own independent session
const sessions = new Map();

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [key, val] of sessions.entries()) {
    if (val.expiresAt < now) sessions.delete(key);
  }
}
setInterval(cleanExpiredSessions, 60_000);

// ── Helper: generate a random session key ──────────────────────────────────
function makeSessionKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── POST /api/connect ──────────────────────────────────────────────────────
// Body: { proshopRoot, authMode, username, password, clientId, clientSecret, scope }
// Returns: { sessionKey, expiresIn, userName? }
app.post('/api/connect', async (req, res) => {
  const { proshopRoot, authMode, username, password, clientId, clientSecret, scope } = req.body;

  if (!proshopRoot) return res.status(400).json({ error: 'proshopRoot is required' });

  const root = proshopRoot.replace(/\/$/, '');
  let token, expiresIn, userName;

  try {
    if (authMode === 'credentials') {
      // OAuth2 Client Credentials Flow
      if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret required' });

      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        ...(scope ? { scope } : {})
      });

      const r = await fetch(`${root}/home/member/oauth/accesstoken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const data = await r.json();
      if (data.error) return res.status(401).json({ error: data.error_description || data.error });
      token = data.access_token;
      expiresIn = data.expires_in || 86400;

    } else {
      // Username / Password beginsession flow
      if (!username || !password) return res.status(400).json({ error: 'username and password required' });

      const r = await fetch(`${root}/api/beginsession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, scope: scope || 'workorders:rw parts:r users:r' })
      });

      const data = await r.json();
      if (!data.authorizationResult?.token) {
        return res.status(401).json({ error: data.apiError || 'Authentication failed' });
      }
      token = data.authorizationResult.token;
      expiresIn = data.authorizationResult.sessionValidForSeconds || 300;
      userName = data.authorizationResult.userName;
    }

    const sessionKey = makeSessionKey();
    sessions.set(sessionKey, {
      token,
      proshopRoot: root,
      authMode,
      expiresAt: Date.now() + expiresIn * 1000
    });

    return res.json({ sessionKey, expiresIn, userName });

  } catch (err) {
    console.error('Connect error:', err.message);
    return res.status(500).json({ error: 'Could not reach ProShop server. Check the URL and try again.' });
  }
});

// ── POST /api/query ────────────────────────────────────────────────────────
// Headers: x-session-key
// Body: { query, variables?, operationName? }
// Proxies to ProShop GraphQL and returns raw result
app.post('/api/query', async (req, res) => {
  const sessionKey = req.headers['x-session-key'];
  if (!sessionKey) return res.status(401).json({ error: 'No session key provided' });

  const session = sessions.get(sessionKey);
  if (!session) return res.status(401).json({ error: 'Session not found or expired. Please reconnect.' });
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionKey);
    return res.status(401).json({ error: 'Session expired. Please reconnect.' });
  }

  const { query, variables, operationName } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    const url = `${session.proshopRoot}/api/graphql`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.token}`
      },
      body: JSON.stringify({ query, variables, operationName })
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(r.status).json(data);
  } catch (err) {
    console.error('Query proxy error:', err.message);
    res.status(500).json({ error: 'Failed to reach ProShop API.' });
  }
});

// ── POST /api/disconnect ───────────────────────────────────────────────────
app.post('/api/disconnect', async (req, res) => {
  const sessionKey = req.headers['x-session-key'];
  const session = sessions.get(sessionKey);

  if (session && session.authMode !== 'credentials') {
    // beginsession tokens should be ended explicitly
    try {
      await fetch(`${session.proshopRoot}/api/endsession?token=${session.token}`);
    } catch (_) {}
  }

  sessions.delete(sessionKey);
  res.json({ ok: true });
});

// ── GET /api/status ────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const sessionKey = req.headers['x-session-key'];
  const session = sessions.get(sessionKey);
  if (!session || session.expiresAt < Date.now()) {
    return res.json({ connected: false });
  }
  res.json({
    connected: true,
    expiresIn: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))
  });
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProShop Playground running on port ${PORT}`));
