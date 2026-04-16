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

## What It Does

- **Seasonal anime calendar** — see what's airing this season with countdowns to next episodes
- **Viewing tracker** — mark shows as `following`, `in jellyfin`, or `watched`
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
├── server.js                 # Express app, session config, sync intervals
├── scripts/
│   └── seed.js               # CLI: seed current season data
├── public/
│   ├── css/style.css
│   └── js/app.js             # countdowns, status toggles, sorting
└── src/
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

**Auth:** `GET/POST /login`, `GET/POST /register`, `GET /logout`

**App:** `GET /` → redirects to current season, `GET /season/:year/:season`

**JSON:** `POST /api/mark` (auth), `GET /api/anime/:mal_id`, `POST /api/lang` (auth)

## Deployment

Runs behind nginx with PM2. See `PLAN.md` for full deployment steps, nginx config, and GitHub Actions CI/CD setup.

## Notes

- `.env` and `anidiary.db` are gitignored
- Back up `anidiary.db` regularly
- See `PLAN.md` for detailed architecture, design spec, and future phases
