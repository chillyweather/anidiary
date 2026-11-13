# anidiary

Personal anime release calendar & viewing tracker for me and my wife.

Server-rendered with EJS, backed by SQLite, syncing metadata from AniList, Jikan, and Shikimori.

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

Views link CSS, JS and fonts through `asset('/js/app.js')`, which appends a content
hash (`?v=<hash>`); a request with the current hash is cached for a year as
immutable, anything else is `no-cache` and revalidates by ETag. Hashes are computed
at startup, and recomputed on file change outside production. The stylesheet's
`@font-face` URLs carry the hash literally; `test/static-assets.test.js` fails when a
font changes without its hash being updated. Other files in `public/` are cached for
a day.

The fonts (Unbounded for the wordmark, season and weekday names; Onest for
everything else) are self-hosted variable WOFF2 files subset to Latin and Cyrillic,
under the SIL Open Font License (`public/fonts/OFL-*.txt`). Japanese text uses the
system's CJK fonts.

Sessions are stored in SQLite only when needed: an anonymous visitor gets one (for
the form's CSRF token) only from `GET /login` or `GET /register`, and it expires
after 1 hour; logging in replaces it with a 30-day session.

## What It Does

- **Your week** — the next seven days in your own time zone, starting today, with
  the episodes of every title you follow or watch (from any season) at their local
  air time
- **Season catalogue** — a poster grid on desktop and compact rows on phones, with
  countdowns, episode progress and scores; search across English, Japanese and
  Russian titles, filter by format, hide watched titles, and sort by popularity,
  score, next episode or title (the list, format, hide-watched and sort choices are
  remembered per browser)
- **Viewing tracker** — one personal state per title (`following`, `watching` or
  `watched`), shown as a tab on the poster; Jellyfin availability is a separate
  shared badge. The other household member's state shows as an initial chip
- **Detail dialog** — synopsis, genres, score links, related titles (those in the
  catalogue open in the dialog) and prequel/sequel navigation
- **Multi-language titles** — English, Japanese, and Russian titles (Shikimori for
  RU), with an English or Russian interface
- **Three-score comparison** — MAL, AniList, and Shikimori ratings side by side
- **Auto-sync** — a background scheduler keeps the current, next, and (while still
  airing) previous season fresh, refreshes countdowns soon after each episode airs,
  and fetches a never-synced season the first time someone opens it

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 20+ (`.nvmrc`: 24; CI tests 20 and 24) |
| Server | Express 4 |
| Database | SQLite (`better-sqlite3`) |
| Auth | `bcrypt` + `express-session` |
| Views | EJS |
| Client | Vanilla JS |

## Data Sources

- **AniList** (catalogue) — season list, titles, English synopsis, posters, episode
  counts, airing status and next-episode countdowns, AniList scores, format,
  popularity, and related series
- **Jikan** (optional enricher) — MAL scores and broadcast day; fallback for titles,
  synopsis, and posters, and for the season list when AniList is down
- **Shikimori** (enricher, GraphQL on `shikimori.io`) — Russian titles/synopses,
  Shikimori scores

All merged by **MAL ID** as the universal key. A provider that fails never erases
stored data; when AniList answers that a title has no next episode, its countdown
is cleared. See `docs/adr/0002-catalogue-source-and-sync-scheduling.md`.

## Sync Scheduling

The server ticks 30 seconds after startup and then every 10 minutes, running at
most one overdue job: the current season after 12h, countdowns every 6h (or within
30 minutes of an episode airing), the next season after 24h, and the previous
season after 24h while it still has airing titles. Incomplete or failed syncs are
retried after 1h with backoff up to 6h. Season syncs run one at a time through a
single queue shared with page views and the CLI. Each run is recorded in the
`sync_state` table, so restarts do not reset the schedule.

## Scripts

- `npm run seed [year season]` — sync one season (default: the current season).
- `node scripts/seed-all-seasons.js [FROM_YEAR FROM_SEASON [TO_YEAR TO_SEASON]] [--force]`
  — backfill a range (default: winter 2009 to the current season), skipping
  seasons already synced completely according to `sync_state`; requests are spaced
  for AniList's 30 requests/minute limit.
- `npm run migrate` — apply database migrations.

## Project Structure

```
anidiary/
├── server.js                 # Executable bootstrap
├── scripts/
│   ├── seed.js               # CLI: sync one season (default: current)
│   └── seed-all-seasons.js   # CLI: backfill a range of seasons
├── public/
│   ├── css/style.css
│   ├── fonts/                # self-hosted Onest and Unbounded (WOFF2) + licences
│   ├── img/mascot.webp       # login page mascot (small copy of anidiary.png)
│   └── js/
│       ├── catalogue.js      # pure: filters, sort, countdown text, week grouping
│       ├── title-item.js     # catalogue item markup, shared by server (HTML) and browser (DOM)
│       ├── detail-loader.js  # detail fetch cache, stale-response guard
│       ├── modal-rendering.js # safe rendering of related titles
│       └── app.js            # season page wiring (one delegated click handler)
└── src/
    ├── app.js                # Side-effect-free Express application factory
    ├── assets.js             # Content-hash URLs for /css, /js and /fonts
    ├── scheduler.js          # Staleness-driven background sync scheduler
    ├── db/
    │   ├── db.js             # SQLite init + helpers
    │   └── schema.sql
    ├── middleware/
    │   ├── auth.js
    │   └── csrf.js
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
        └── partials/         # head, navigation, title (renders title-item.js), app-scripts
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
backup, and migration must all succeed before PM2 reloads. The `/healthz` smoke
check is tried `SMOKE_ATTEMPTS` times (default 30), `SMOKE_DELAY_SECONDS` apart
(default 1). After a successful release only, the script keeps the newest
`KEEP_RELEASES` (default 5) `releases/<sha>` directories and `KEEP_BACKUPS`
(default 10) `backups/anidiary-*.db` files by modification time, never deleting the
current release, the one in `.previous-release`, or this run's backup; a pruning
error is logged and does not fail the deploy.

For recovery, inspect `$APP_DIR/.previous-release` and the backup path printed in the
deployment log. Reload the prior code with
`DB_PATH=$APP_DIR/anidiary.db pm2 startOrReload <previous>/ecosystem.config.js --env production --update-env`.
If the migration itself must be reversed, stop Anidiary, preserve the failed database,
restore the logged backup to `$APP_DIR/anidiary.db`, then reload the prior release.

## Notes

- `.env` and `anidiary.db` are gitignored
- Back up `anidiary.db` regularly
- See `PLAN.md` for detailed architecture, design spec, and future phases
