const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── Simple rate limiter: max 20 requests per minute per session ────────────
const queryTimestamps = new Map(); // sessionKey -> [timestamps]
function isRateLimited(sessionKey) {
  const now = Date.now();
  const window = 60_000; // 1 minute
  const max = 20;        // max 20 queries per minute
  if (!queryTimestamps.has(sessionKey)) queryTimestamps.set(sessionKey, []);
  const times = queryTimestamps.get(sessionKey).filter(t => now - t < window);
  times.push(now);
  queryTimestamps.set(sessionKey, times);
  return times.length > max;
}

// In-memory session store: sessionKey -> { token, proshopRoot, expiresAt }
const sessions = new Map();

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [key, val] of sessions.entries()) {
    if (val.expiresAt < now) sessions.delete(key);
  }
}
setInterval(cleanExpiredSessions, 60_000);

function makeSessionKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── POST /api/connect ──────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { proshopRoot, authMode, username, password, clientId, clientSecret, scope } = req.body;

  if (!proshopRoot) return res.status(400).json({ error: 'proshopRoot is required' });

  const root = proshopRoot.replace(/\/$/, '');
  let token, expiresIn, userName;

  try {
    if (authMode === 'credentials') {
      if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret required' });

      // Try the standard OAuth2 client_credentials endpoint
      const oauthUrl = `${root}/home/member/oauth/accesstoken`;
      console.log(`[connect] Trying client_credentials at: ${oauthUrl}`);

      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        ...(scope ? { scope } : {})
      });

      const r = await fetch(oauthUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      console.log(`[connect] OAuth response status: ${r.status}`);

      // If 404, the Worker may use a different path — try /api/token or /oauth/token
      if (r.status === 404) {
        // Try alternate paths that some ProShop Worker deployments use
        const altPaths = [
          `${root}/api/token`,
          `${root}/oauth/token`,
          `${root}/api/oauth/accesstoken`,
        ];

        let success = false;
        for (const altUrl of altPaths) {
          console.log(`[connect] Trying alternate OAuth path: ${altUrl}`);
          const r2 = await fetch(altUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
          });
          console.log(`[connect] Alt response status: ${r2.status}`);
          if (r2.status !== 404) {
            const data2 = await r2.json();
            console.log(`[connect] Alt response body:`, JSON.stringify(data2).slice(0, 200));
            if (data2.access_token) {
              token = data2.access_token;
              expiresIn = data2.expires_in || 86400;
              success = true;
              break;
            }
            if (data2.error) {
              return res.status(401).json({ error: data2.error_description || data2.error });
            }
          }
        }

        if (!success) {
          return res.status(404).json({
            error: `OAuth endpoint not found. Tried: ${oauthUrl} and alternates. Check your ProShop Worker URL — it should point directly to your ProShop instance (e.g. https://yourco.adionsystems.com), not a proxy root.`
          });
        }
      } else {
        const text = await r.text();
        console.log(`[connect] OAuth body:`, text.slice(0, 300));
        let data;
        try { data = JSON.parse(text); } catch { return res.status(500).json({ error: 'OAuth endpoint returned non-JSON: ' + text.slice(0, 100) }); }
        if (data.error) return res.status(401).json({ error: data.error_description || data.error });
        token = data.access_token;
        expiresIn = data.expires_in || 86400;
      }

    } else {
      // Username / Password beginsession flow
      if (!username || !password) return res.status(400).json({ error: 'username and password required' });

      const sessionUrl = `${root}/api/beginsession`;
      console.log(`[connect] Trying beginsession at: ${sessionUrl}`);

      const r = await fetch(sessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, scope: scope || 'workorders:rw parts:r users:r' })
      });

      console.log(`[connect] beginsession response status: ${r.status}`);
      const text = await r.text();
      console.log(`[connect] beginsession body:`, text.slice(0, 300));

      let data;
      try { data = JSON.parse(text); } catch { return res.status(500).json({ error: 'beginsession returned non-JSON: ' + text.slice(0, 100) }); }

      if (!data.authorizationResult?.token) {
        return res.status(401).json({ error: data.apiError || 'Authentication failed — no token returned' });
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

    console.log(`[connect] Session created: ${sessionKey.slice(0, 8)}... expires in ${expiresIn}s`);
    return res.json({ sessionKey, expiresIn, userName });

  } catch (err) {
    console.error('[connect] Error:', err.message);
    return res.status(500).json({
      error: `Could not reach ProShop server: ${err.message}. URL: ${root}`
    });
  }
});

// ── POST /api/query ────────────────────────────────────────────────────────
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

  // Rate limit check
  if (isRateLimited(sessionKey)) {
    console.warn(`[query] Rate limit hit for session ${sessionKey.slice(0,8)}`);
    return res.status(429).json({ error: 'Too many requests — please wait a moment before running another query.' });
  }

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
    console.error('[query] Error:', err.message);
    res.status(500).json({ error: 'Failed to reach ProShop API: ' + err.message });
  }
});

// ── POST /api/disconnect ───────────────────────────────────────────────────
app.post('/api/disconnect', async (req, res) => {
  const sessionKey = req.headers['x-session-key'];
  const session = sessions.get(sessionKey);

  if (session && session.authMode !== 'credentials') {
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

// ── GET /api/debug ─────────────────────────────────────────────────────────
// Hit this in browser to see active session count (dev only)
app.get('/api/debug', (req, res) => {
  res.json({ activeSessions: sessions.size, uptime: process.uptime() });
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProShop Director running on port ${PORT}`));
