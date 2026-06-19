# anidiary

Personal anime release calendar & viewing tracker for me and my wife.

Server-rendered with EJS, backed by SQLite, syncing metadata from Jikan, AniList, and Shikimori.

## Quick Start

```bash
npm install
cp .env.example .env
# Set SESSION_SECRET in .env
npm run seed
npm start
```

Open `http://localhost:3000/login`

Set `DB_PATH` to choose the SQLite database explicitly. Production defaults to
`anidiary.db`; tests create a unique temporary database. Run the full local and CI
test suite with:

```bash
npm test
```

Production registration is closed by default. Set `REGISTRATION_OPEN=true` only
while intentionally creating accounts. New passwords must contain at least 12
characters and no more than 72 UTF-8 bytes. Set `TRUST_PROXY=1` for the documented
single reverse-proxy deployment, or provide a comma-separated trusted subnet list;
leave it unset when clients connect directly.

## What It Does

- **Seasonal anime calendar** — see what's airing this season with countdowns to next episodes
- **Viewing tracker** — mark a personal state as `following` or `watched`, independently from shared Jellyfin availability
- **Multi-language titles** — toggle between English, Japanese, and Russian titles (Shikimori for RU)
- **Three-score comparison** — MAL, AniList, and Shikimori ratings side by side
- **Auto-sync** — countdowns refresh every 6h, full season sync every 24h

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 18+ |
| Server | Express 4 |
| Database | SQLite (`better-sqlite3`) |
| Auth | `bcrypt` + `express-session` |
| Views | EJS |
| Client | Vanilla JS |

## Data Sources

- **Jikan** (primary) — seasonal catalog, MAL scores, episode counts
- **AniList** — next airing timestamps, AniList scores
- **Shikimori** — Russian titles/synopses, Shikimori scores

All merged by **MAL ID** as the universal key.

## Project Structure

```
anidiary/
├── server.js                 # Executable bootstrap
├── scripts/
│   └── seed.js               # CLI: seed current season data
├── public/
│   ├── css/style.css
│   └── js/app.js             # countdowns, status toggles, sorting
└── src/
    ├── app.js                # Side-effect-free Express application factory
    ├── scheduler.js          # Explicit background timer lifecycle
    ├── db/
    │   ├── db.js             # SQLite init + helpers
    │   └── schema.sql
    ├── middleware/
    │   └── auth.js
    ├── routes/
    │   ├── auth.js           # /login, /register, /logout
    │   ├── season.js         # /season/:year/:season
    │   └── api.js            # /api/mark, /api/anime/:id, /api/lang
    ├── services/
    │   ├── rateLimiter.js
    │   ├── jikan.js
    │   ├── anilist.js
    │   ├── shikimori.js
    │   └── sync.js           # merge orchestrator
    └── views/
        ├── login.ejs
        ├── register.ejs
        ├── season.ejs
        ├── error.ejs
        └── partials/card.ejs
```

## API Endpoints

**Auth:** `GET/POST /login`, `GET/POST /register`, `POST /logout`

**App:** `GET /` → redirects to current season, `GET /season/:year/:season`

**JSON:** authenticated `POST /api/mark`, `POST /api/jellyfin`,
`GET /api/anime/:mal_id`, and `POST /api/lang`

## Deployment

Runs behind nginx with PM2. See `PLAN.md` for full deployment steps, nginx config, and GitHub Actions CI/CD setup.

Deployment requires a protected `SSH_KNOWN_HOSTS` secret containing the pinned host
key; the runner never discovers trust from the network. Each verified commit is
staged under `$APP_DIR/releases/<sha>`. Before migration, deployment creates an
integrity-checked SQLite backup under `$APP_DIR/backups`, and dependency install,
backup, and migration must all succeed before PM2 reloads.

For recovery, inspect `$APP_DIR/.previous-release` and the backup path printed in the
deployment log. Reload the prior code with
`DB_PATH=$APP_DIR/anidiary.db pm2 startOrReload <previous>/ecosystem.config.js --env production --update-env`.
If the migration itself must be reversed, stop Anidiary, preserve the failed database,
restore the logged backup to `$APP_DIR/anidiary.db`, then reload the prior release.

## Notes

- `.env` and `anidiary.db` are gitignored
- Back up `anidiary.db` regularly
- See `PLAN.md` for detailed architecture, design spec, and future phases
