# ProShop GraphQL Playground

A self-hosted GraphQL playground for ProShop (adion systems) with a secure backend proxy. Each visitor enters their own credentials — nothing is hardcoded.

## How it works

```
Browser → Express server (Railway) → ProShop API
```

Credentials **never leave the server**. The browser only holds a temporary `sessionKey` (a random string). The server stores the actual ProShop token in memory.

## Auth methods supported

| Method | How |
|---|---|
| **Username / Password** | Uses `/api/beginsession` — standard user login |
| **Client Credentials** | Uses OAuth2 `/home/member/oauth/accesstoken` — for app-level access |

## Local development

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "ProShop Playground"
gh repo create proshop-playground --private --push --source=.
# or: git remote add origin https://github.com/YOU/proshop-playground.git && git push -u origin main
```

### 2. Deploy on Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select your `proshop-playground` repo
3. Railway auto-detects Node.js and runs `npm start`
4. Your public URL will be something like `https://proshop-playground-production.up.railway.app`

### 3. CORS in ProShop (if needed)

If you get **403 Forbidden** responses:

1. In ProShop, hover your company name → **System Config** → **Dev** tab
2. Find **allowListCORS** → add your Railway domain: `https://proshop-playground-production.up.railway.app`
3. Save

> Note: Because queries are proxied server-side, CORS is only needed if ProShop itself checks the `Origin` header on the server-to-server request. Most installations won't need this.

## Sharing the link

Send anyone your Railway URL. Each person:
1. Opens the link in their browser
2. Enters **their own** ProShop URL + credentials
3. Gets their own isolated session — no one shares tokens

Sessions are stored in server memory and expire automatically (24h for Client Credentials, 5min for beginsession tokens unless refreshed).

## Project structure

```
proshop-playground/
├── server.js          # Express backend (auth proxy)
├── package.json
├── .gitignore
└── public/
    └── index.html     # Full SPA frontend
```

## Environment variables (optional)

Railway auto-sets `PORT`. No other env vars needed — credentials are entered by each user at runtime.
