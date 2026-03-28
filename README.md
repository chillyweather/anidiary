# anidiary

Personal anime release calendar and viewing tracker.

This app is server-rendered (EJS), uses SQLite for data/session storage, and syncs anime metadata from:

- Jikan (primary seasonal catalog)
- AniList (next airing episode + AniList score)
- Shikimori (Russian title/synopsis + score)

## Stack

- Node.js `>=18`
- Express 4
- SQLite (`better-sqlite3`)
- Sessions: `express-session` + `better-sqlite3-session-store`
- Auth: `bcrypt`
- Views: EJS
- Client: Vanilla JS

## Features (current)

- Username/password auth (register, login, logout)
- Seasonal anime page with:
  - countdowns for next episode
  - status actions (`following`, `in_jellyfin`, `watched`)
  - language toggle (`en`, `jp`, `ru`)
  - client-side tabs and sorting
- Background sync jobs:
  - refresh countdowns every 6h
  - full current-season sync every 24h
- Manual seed command for initial population

## Project Structure

```text
anidiary/
├── server.js
├── scripts/
│   └── seed.js
├── public/
│   ├── css/style.css
│   └── js/app.js
└── src/
    ├── db/
    │   ├── db.js
    │   └── schema.sql
    ├── middleware/
    │   └── auth.js
    ├── routes/
    │   ├── auth.js
    │   ├── season.js
    │   └── api.js
    ├── services/
    │   ├── rateLimiter.js
    │   ├── jikan.js
    │   ├── anilist.js
    │   ├── shikimori.js
    │   └── sync.js
    └── views/
        ├── login.ejs
        ├── register.ejs
        ├── season.ejs
        ├── error.ejs
        └── partials/card.ejs
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

3. Set at least:

```env
SESSION_SECRET=<strong-random-secret>
PORT=3000
```

`SESSION_SECRET` is required in production.

## Running Locally

Seed current season:

```bash
npm run seed
```

Or seed explicit season:

```bash
npm run seed -- 2026 winter
```

Start server:

```bash
npm start
```

Open:

`http://localhost:3000/login`

## Available Scripts

- `npm start` - starts Express server
- `npm run seed` - syncs anime data into SQLite (`anidiary.db`)

## Sync and Data Model

Merge key: **MAL ID**

1. Pull season list from Jikan
2. Pull same season from AniList and map by `idMal`
3. Pull Shikimori details by MAL ID
4. Merge and upsert into `anime`

Important DB tables:

- `anime` - merged metadata and scores
- `users` - auth + language preference
- `user_anime` - per-user status
- `watch_history` - reserved for later phase
- `sessions` - session store table (managed by session store)

## API Endpoints

Auth:

- `GET /login`
- `POST /login`
- `GET /register`
- `POST /register`
- `GET /logout`

App:

- `GET /` -> redirects to current season
- `GET /season/:year/:season`

JSON API:

- `POST /api/mark` (auth required)
- `GET /api/anime/:mal_id`
- `POST /api/lang` (auth required)

## Production Notes

- App expects to run behind a reverse proxy (nginx)
- Session cookie is `secure` in production (`NODE_ENV=production`)
- Keep `.env` and `anidiary.db` out of git
- Back up `anidiary.db` regularly

## CI/CD (GitHub Actions)

Two workflows are included:

- `CI` (`.github/workflows/ci.yml`)
  - runs on pull requests and pushes to `main`
  - installs dependencies and performs a basic smoke test (`/login`, `/register`)
- `Deploy` (`.github/workflows/deploy.yml`)
  - runs on push to `main` (and manual trigger)
  - uploads files to your server via `rsync`
  - runs `npm ci --omit=dev`
  - reloads app with PM2 using `ecosystem.config.js`

### Required GitHub Secrets

Set these in GitHub repository settings (`Settings -> Secrets and variables -> Actions`):

- `SERVER_HOST` - server IP or hostname
- `SERVER_PORT` - SSH port (usually `22`)
- `SERVER_USER` - SSH user
- `SSH_PRIVATE_KEY` - private key used by GitHub Actions to SSH into server
- `APP_DIR` - absolute deploy path on server (for example `/var/www/anidiary`)

### One-time Server Setup

On your server (Ubuntu/Debian example):

```bash
sudo apt update
sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

sudo mkdir -p /var/www/anidiary
sudo chown -R $USER:$USER /var/www/anidiary
cd /var/www/anidiary

cat > .env << 'EOF'
SESSION_SECRET=replace-with-strong-secret
PORT=3000
NODE_ENV=production
EOF
```

Then run first deploy from GitHub Actions and seed data once:

```bash
cd /var/www/anidiary
npm run seed -- 2026 winter
```

### PM2 commands on server

```bash
pm2 status
pm2 logs anidiary
pm2 restart anidiary
```

## Known Scope

This repository currently implements core MVP behavior. Optional integrations (Jellyfin/Plex/OAuth imports/AI features) are intentionally out of scope for now.
