
# anidiary.site — Project Plan

> Personal anime release calendar & viewing tracker. Built for Dmitri + wife. Possibly public later.

---

## 1\. API Research & Data Sources

### Primary: Jikan v4 (unofficial MAL API)

*   **Base URL:** `https://api.jikan.moe/v4`
*   **Auth:** None (public, rate-limited to 3 req/sec, 60 req/min)
*   **What we use it for:** Full seasonal catalog, MAL scores, episode counts, English synopses, poster images, related series, MAL IDs
*   **Endpoints we call:**
    *   `GET /seasons/{year}/{season}` — returns paginated list of all anime in a season. Params: `?page=1&sfw=true`. Response includes `pagination.has_next_page`. Loop until no more pages.
    *   `GET /anime/{mal_id}/full` — full details including `relations[]` array for related series
    *   `GET /schedules?filter={day}` — weekly airing schedule (optional, AniList countdown is better)
*   **Rate limit handling:** Wait 350ms between requests. On 429 response, wait 2 seconds and retry up to 3 times.
*   **Limitation:** English-only titles/descriptions. No precise next-episode timestamps.

### Secondary: Shikimori API

*   **Base URL:** `https://shikimori.one/api/`
*   **Auth:** Public for read-only. OAuth2 only needed later for user list import (Phase 2).
*   **Required header:** `User-Agent: Anidiary` (Shikimori rejects requests without a User-Agent)
*   **What we use it for:** Russian titles (`russian` field), Russian descriptions (`description` field), Shikimori scores
*   **Endpoints we call:**
    *   `GET /api/animes/{mal_id}` — anime details by MAL ID. Returns `{ russian, description, score, ... }`. The `description` field is in Russian and contains HTML — strip tags before storing.
    *   `GET /api/animes?season={year}_{season}&limit=50&page=1` — seasonal listing (backup, primary source is Jikan)
*   **Cross-reference:** Shikimori uses MAL IDs natively. The `id` in Shikimori response IS the MAL ID. No mapping table needed.
*   **Rate limit handling:** Wait 250ms between requests. Max 5 req/sec, 90 req/min.

### Tertiary: AniList GraphQL API

*   **URL:** `https://graphql.anilist.co` (POST)
*   **Auth:** None for public queries
*   **What we use it for:** AniList scores, precise next-episode countdown (`nextAiringEpisode.airingAt` is a unix timestamp), native/romaji titles
*   **The exact query to use:**
    
    ```graphql
    query ($season: MediaSeason, $year: Int, $page: Int) {  Page(page: $page, perPage: 50) {    pageInfo { hasNextPage currentPage }    media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC) {      idMal      title { romaji english native }      nextAiringEpisode { airingAt episode }      episodes      averageScore      coverImage { large }      genres    }  }}
    ```
    
    Variables: `{ "season": "WINTER", "year": 2026, "page": 1 }`. Season values: `WINTER`, `SPRING`, `SUMMER`, `FALL`. Loop while `pageInfo.hasNextPage === true`.
*   **Cross-reference:** `idMal` in AniList response = MAL ID. Some entries have `idMal: null` (AniList-only entries) — skip those.
*   **Rate limit handling:** 90 req/min. In practice, 1–2 paginated requests covers a full season, so this is never an issue.

### Data Merge Strategy (important — read carefully)

All three APIs are merged by **MAL ID** as the universal key. The sync function must:

1.  Fetch season from **Jikan** — this is the canonical list. Each result has `mal_id`.
2.  Fetch season from **AniList** — build a Map: `anilistData.get(idMal) → { averageScore, nextAiringEpisode, title.native }`.
3.  Fetch each anime from **Shikimori** by MAL ID — build a Map: `shikiData.get(mal_id) → { russian, description, score }`.
4.  For each Jikan anime, merge in AniList + Shikimori data. If AniList or Shikimori has no match for a given MAL ID, leave those fields `NULL`.
5.  Upsert into `anime` table (INSERT OR REPLACE).

### Ratings Available for Sorting

| Source | Field | Scale | Notes |
| --- | --- | --- | --- |
| MyAnimeList | `score_mal` | 1.0–10.0 | Broadest community |
| AniList | `score_anilist` | 1–100 | More niche/enthusiast. Display as-is, don't divide by 10 |
| Shikimori | `score_shiki` | 1.0–10.0 | Russian-speaking community |

---

## 2\. Tech Stack

No build step. No frontend framework. No bundler.

| Layer | Technology | Why |
| --- | --- | --- |
| Runtime | Node.js (v20+) | Already familiar, runs on Nanode |
| Server | Express 4.x | Minimal, well-documented |
| Database | SQLite via `better-sqlite3` | Zero ops, single file, perfect for 2 users |
| Auth | `bcrypt` for password hashing, `express-session` with `better-sqlite3-session-store` for cookie sessions | Simple, no external deps |
| Templating | EJS | Server-rendered HTML, no client-side framework |
| Client JS | Vanilla JS | Countdown timers, status toggles, sort/filter — no framework needed |
| Fonts | Google Fonts: `Nunito` (400, 700 weights only) | Warm, rounded, cozy feel |
| Process manager | PM2 | Auto-restart, logs |
| Reverse proxy | nginx | Already on Nanode, handles SSL |
| SSL | Let's Encrypt via certbot | Free, auto-renew |

### Dependencies (package.json)

```json
{
  "dependencies": {
    "express": "^4.18",
    "better-sqlite3": "^11.0",
    "better-sqlite3-session-store": "^0.1",
    "express-session": "^1.18",
    "bcrypt": "^5.1",
    "ejs": "^3.1",
    "node-fetch": "^3.3"
  },
  "devDependencies": {},
  "scripts": {
    "start": "node server.js",
    "seed": "node scripts/seed.js"
  }
}
```

---

## 3\. Directory Structure

```
anidiary/
├── server.js                      # Express app: middleware, routes, session config, listen on port 3000
├── package.json
├── .env                           # SESSION_SECRET=<random string>, PORT=3000
├── anidiary.db                    # SQLite database file (gitignored)
│
├── src/
│   ├── routes/
│   │   ├── auth.js                # POST /register, POST /login, GET /logout
│   │   ├── season.js              # GET /season/:year/:season — renders season page
│   │   └── api.js                 # POST /api/mark — toggle user_anime status
│   │                              # GET  /api/anime/:mal_id — JSON detail for client-side use
│   │
│   ├── services/
│   │   ├── jikan.js               # fetchSeason(year, season) → array of anime objects
│   │   │                          # fetchAnimeDetail(malId) → single anime with relations
│   │   │                          # Handles pagination, rate limiting, retries
│   │   │
│   │   ├── anilist.js             # fetchSeason(season, year) → Map<malId, {score, nextEp, titleNative}>
│   │   │                          # Handles GraphQL pagination
│   │   │
│   │   ├── shikimori.js           # fetchAnime(malId) → {russian, description, score}
│   │   │                          # fetchBatch(malIds) → Map<malId, data> (calls one by one with delay)
│   │   │
│   │   └── sync.js                # syncSeason(year, season):
│   │                              #   1. Call jikan.fetchSeason()
│   │                              #   2. Call anilist.fetchSeason()
│   │                              #   3. Call shikimori.fetchBatch(allMalIds)
│   │                              #   4. Merge by MAL ID
│   │                              #   5. Upsert into anime table
│   │                              # refreshCountdowns():
│   │                              #   1. Call anilist.fetchSeason() for current season only
│   │                              #   2. Update next_ep_num and next_ep_at in DB
│   │
│   ├── db/
│   │   ├── schema.sql             # CREATE TABLE statements (see §4)
│   │   └── db.js                  # const db = require('better-sqlite3')('./anidiary.db');
│   │                              # Run schema.sql on first launch if tables don't exist
│   │                              # Export db instance + prepared statement helpers
│   │
│   ├── middleware/
│   │   └── auth.js                # requireLogin(req, res, next): if !req.session.userId → redirect /login
│   │
│   └── views/
│       ├── layout.ejs             # HTML skeleton: <head>, font link, nav bar, <%- body %>, footer
│       ├── login.ejs              # Login form + link to register
│       ├── register.ejs           # Register form + link to login
│       ├── season.ejs             # Main page: season picker, tabs, sort controls, card grid
│       └── partials/
│           └── card.ejs           # Single anime card partial (receives anime + userStatus objects)
│
├── public/
│   ├── css/
│   │   └── style.css              # All styles (see §6 for design spec)
│   ├── js/
│   │   └── app.js                 # Client-side JS:
│   │                              #   - Countdown timers (update every second)
│   │                              #   - Status button click → fetch POST /api/mark
│   │                              #   - Sort dropdown change → reorder DOM cards
│   │                              #   - Tab switch (All / Following) → show/hide cards
│   └── favicon.ico
│
└── scripts/
    └── seed.js                    # CLI script: calls sync.syncSeason() for current season
                                   # Usage: node scripts/seed.js [year] [season]
                                   # Defaults to current season if no args
```

---

## 4\. Database Schema

Create these tables in `src/db/schema.sql`. The `db.js` module should run this file on startup if the `anime` table does not exist (`SELECT name FROM sqlite_master WHERE type='table' AND name='anime'`).

```sql
CREATE TABLE IF NOT EXISTS anime (
  mal_id         INTEGER PRIMARY KEY,
  title_en       TEXT,                    -- English title from Jikan or AniList
  title_jp       TEXT,                    -- Native (kanji) from AniList, romaji from Jikan as fallback
  title_ru       TEXT,                    -- Russian from Shikimori (NULL if unavailable)
  synopsis_en    TEXT,                    -- English synopsis from Jikan
  synopsis_ru    TEXT,                    -- Russian synopsis from Shikimori (HTML stripped)
  poster_url     TEXT,                    -- CDN URL from Jikan (images.jpg_image_url) or AniList (coverImage.large)
  score_mal      REAL,                    -- MAL score (1.0-10.0), NULL if unscored
  score_anilist  REAL,                    -- AniList score (1-100), NULL if unscored
  score_shiki    REAL,                    -- Shikimori score (1.0-10.0), NULL if unscored
  episodes_total INTEGER,                 -- Total episodes this season, NULL if unknown/TBA
  season         TEXT NOT NULL,           -- Format: 'winter_2026', 'spring_2026', etc.
  airing_day     TEXT,                    -- Lowercase day name: 'monday', 'tuesday', etc. From Jikan broadcast.day
  next_ep_num    INTEGER,                 -- Next episode number (from AniList nextAiringEpisode.episode)
  next_ep_at     INTEGER,                 -- Unix timestamp of next episode air (from AniList nextAiringEpisode.airingAt)
  anilist_id     INTEGER,                 -- AniList ID (for linking out)
  genres         TEXT,                    -- JSON array of strings, e.g. '["Action","Comedy"]'
  related        TEXT,                    -- JSON array: '[{"mal_id":123,"relation":"Sequel","title":"..."}]'
  updated_at     INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,           -- bcrypt hash, cost factor 12
  lang_pref      TEXT DEFAULT 'en',       -- 'en', 'jp', or 'ru'
  created_at     INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS user_anime (
  user_id        INTEGER NOT NULL,
  mal_id         INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('following', 'in_jellyfin', 'watched')),
  episodes_seen  INTEGER DEFAULT 0,       -- For future Jellyfin integration
  updated_at     INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, mal_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
);

-- Phase 2: watch history log
CREATE TABLE IF NOT EXISTS watch_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  mal_id         INTEGER NOT NULL,
  episode        INTEGER,
  watched_at     INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
);

-- Session store table (created automatically by better-sqlite3-session-store, but for reference):
-- sessions(sid TEXT PRIMARY KEY, expired INTEGER, sess TEXT)

CREATE INDEX IF NOT EXISTS idx_anime_season ON anime(season);
CREATE INDEX IF NOT EXISTS idx_user_anime_user ON user_anime(user_id);
CREATE INDEX IF NOT EXISTS idx_user_anime_status ON user_anime(user_id, status);
```

---

## 5\. Route & API Specifications

### 5.1 Auth Routes (`src/routes/auth.js`)

**GET /login** — Render `login.ejs`. If already logged in (`req.session.userId`), redirect to `/`.

**POST /login** — Body: `{ username, password }`. Look up user by username. Compare password with `bcrypt.compare()`. On success: set `req.session.userId = user.id` and `req.session.username = user.username`, redirect to `/`. On failure: re-render `login.ejs` with error message "Invalid username or password".

**GET /register** — Render `register.ejs`. If already logged in, redirect to `/`.

**POST /register** — Body: `{ username, password }`. Validate: username 3–20 chars alphanumeric, password 6+ chars. Hash password with `bcrypt.hash(password, 12)`. Insert into `users` table. On duplicate username: re-render with error. On success: set session, redirect to `/`.

**GET /logout** — `req.session.destroy()`, redirect to `/login`.

### 5.2 Season Routes (`src/routes/season.js`)

**GET /** — Redirect to `/season/{currentYear}/{currentSeason}`. Determine current season from month: Jan–Mar = winter, Apr–Jun = spring, Jul–Sep = summer, Oct–Dec = fall.

**GET /season/:year/:season** — Requires login (use `requireLogin` middleware).

1.  Query `anime` table: `SELECT * FROM anime WHERE season = ? ORDER BY score_mal DESC` (default sort).
2.  Query `user_anime` table: `SELECT * FROM user_anime WHERE user_id = ?` — build a Map: `userStatuses.get(mal_id) → status`.
3.  Render `season.ejs` with: `{ animeList, userStatuses, year, season, user: req.session }`.

The template renders ALL cards. The "Following" tab filter is handled client-side by hiding/showing cards based on a `data-followed="true"` attribute.

### 5.3 API Routes (`src/routes/api.js`)

**POST /api/mark** — Requires login. Body: `{ mal_id: number, status: string }`.

*   If status is one of `'following'`, `'in_jellyfin'`, `'watched'`: upsert into `user_anime` (INSERT OR REPLACE).
*   If status is `'none'` or `''`: DELETE from `user_anime` WHERE user\_id AND mal\_id.
*   Return `{ ok: true, status: <new status or null> }`.

**GET /api/anime/:mal\_id** — Returns JSON detail for a single anime (for future modal/detail view). No auth required.

**POST /api/lang** — Requires login. Body: `{ lang: 'en' | 'jp' | 'ru' }`. Update `users.lang_pref`. Return `{ ok: true }`. Page reloads client-side.

---

## 6\. Design Specification

### 6.1 CSS Custom Properties (put at top of style.css)

```css
:root {
  --bg:          #FAF6F1;    /* warm cream page background */
  --card-bg:     #FFFFFF;
  --card-shadow: 0 2px 8px rgba(139, 109, 80, 0.08);
  --card-hover-shadow: 0 6px 20px rgba(139, 109, 80, 0.15);
  --accent:      #D4845A;    /* warm terracotta — buttons, active states */
  --accent-hover:#C2785C;
  --text:        #3D3229;    /* dark warm brown for body text */
  --text-light:  #8C7B6B;    /* muted brown for secondary text */
  --border:      #E8E0D8;    /* warm light border */
  --badge-bg:    #FFF3E0;    /* warm amber background for countdown badge */
  --badge-text:  #BF6A3A;
  --success:     #7CB382;    /* green for "watched" */
  --info:        #6BA3BE;    /* blue for "in jellyfin" */
  --radius:      14px;
  --font:        'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

### 6.2 Layout

*   Max content width: `1200px`, centered with `margin: 0 auto`.
*   Card grid: `display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px;`
*   Responsive: on screens < 640px, cards go full width (single column).
*   Nav bar: fixed top, 56px height, warm cream background with bottom border.

### 6.3 Card Structure (HTML)

```html
<div class="card" data-mal-id="12345" data-followed="true" data-score-mal="8.4" data-score-al="84" data-score-shiki="8.2" data-next-ep-at="1706000000">
  <img class="card__poster" src="..." alt="..." loading="lazy" />
  <div class="card__body">
    <h3 class="card__title">Title in preferred language</h3>
    <p class="card__subtitle">Title in other language(s)</p>
    <div class="card__countdown">
      <span class="countdown-timer" data-timestamp="1706000000">in 7h 23m</span>
      <span class="countdown-ep">ep 11/13</span>
    </div>
    <div class="card__scores">
      <span class="score score--mal">MAL 8.4</span>
      <span class="score score--al">AL 84</span>
      <span class="score score--shiki">Shiki 8.2</span>
    </div>
    <p class="card__synopsis">Short synopsis text, truncated to ~150 chars...</p>
    <div class="card__actions">
      <button class="btn btn--follow" data-status="following">♡ Follow</button>
      <button class="btn btn--jellyfin" data-status="in_jellyfin">📦 Jellyfin</button>
      <button class="btn btn--watched" data-status="watched">✓ Watched</button>
    </div>
  </div>
</div>
```

### 6.4 Card Styling

*   Poster: `width: 100px; height: 140px; object-fit: cover; border-radius: 10px;` floated left or placed in a flex row with the body.
*   Card: `background: var(--card-bg); border-radius: var(--radius); padding: 16px; box-shadow: var(--card-shadow); transition: transform 0.2s, box-shadow 0.2s;`
*   Card hover: `transform: translateY(-3px); box-shadow: var(--card-hover-shadow);`
*   Status buttons: pill-shaped (`border-radius: 20px; padding: 6px 14px;`). Default: outlined with `var(--border)`. Active state: filled with respective color (`--accent` for follow, `--info` for jellyfin, `--success` for watched).
*   Countdown badge: `background: var(--badge-bg); color: var(--badge-text); border-radius: 8px; padding: 4px 10px; font-weight: 700; font-size: 0.85rem;`

### 6.5 Header / Nav

```html
<nav class="nav">
  <a class="nav__logo" href="/">anidiary</a>
  <div class="nav__season-picker">
    <a href="/season/2025/fall">← Fall 2025</a>
    <span class="nav__current">Winter 2026</span>
    <a href="/season/2026/spring">Spring 2026 →</a>
  </div>
  <div class="nav__right">
    <div class="lang-toggle">
      <button data-lang="en" class="active">EN</button>
      <button data-lang="jp">JP</button>
      <button data-lang="ru">RU</button>
    </div>
    <span class="nav__user">dmitri</span>
    <a href="/logout">logout</a>
  </div>
</nav>
```

### 6.6 Controls Row (below nav, above grid)

```html
<div class="controls">
  <div class="controls__tabs">
    <button class="tab active" data-tab="all">All</button>
    <button class="tab" data-tab="following">Following</button>
  </div>
  <div class="controls__sort">
    <label>Sort by:</label>
    <select id="sort-select">
      <option value="score_mal">MAL Score</option>
      <option value="score_al">AniList Score</option>
      <option value="score_shiki">Shikimori Score</option>
      <option value="next_ep">Next Episode</option>
      <option value="title">Title</option>
    </select>
  </div>
</div>
```

---

## 7\. Client-Side JavaScript Specification (`public/js/app.js`)

### 7.1 Countdown Timers

On page load, find all elements with class `countdown-timer`. Each has a `data-timestamp` attribute (unix seconds). Every second, update the text content:

```javascript
function updateCountdowns() {
  document.querySelectorAll('.countdown-timer').forEach(el => {
    const target = parseInt(el.dataset.timestamp) * 1000; // to ms
    const diff = target - Date.now();
    if (diff <= 0) {
      el.textContent = 'aired';
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (days > 0) el.textContent = `in ${days}d ${hrs}h`;
    else if (hrs > 0) el.textContent = `in ${hrs}h ${mins}m`;
    else el.textContent = `in ${mins}m`;
  });
}
setInterval(updateCountdowns, 1000);
updateCountdowns(); // run immediately
```

### 7.2 Status Toggle Buttons

Each `.card__actions button` has a `data-status` value. On click:

1.  Read `mal_id` from closest `.card`'s `data-mal-id`.
2.  If this button is already active (has `.active` class), send `status: 'none'` to deactivate. Otherwise send the button's `data-status`.
3.  `fetch('/api/mark', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ mal_id, status }) })`.
4.  On success: toggle `.active` class on the button. Remove `.active` from sibling buttons (only one status at a time). Update the card's `data-followed` attribute (`'true'` if any status is active, `'false'` if none).

### 7.3 Tab Switching (All / Following)

On tab button click:

*   If "All": show all `.card` elements.
*   If "Following": hide all `.card` elements where `data-followed` is not `'true'`.
*   Update active tab styling.

### 7.4 Sorting

On `#sort-select` change:

1.  Read selected value.
2.  Get all `.card` elements as an array.
3.  Sort by the relevant `data-*` attribute (numeric descending for scores, ascending for `next_ep`, alphabetical for title).
4.  Re-append cards to the grid container in new order (DOM re-ordering, no page reload).

### 7.5 Language Toggle

On language button click:

1.  `fetch('/api/lang', { method: 'POST', ... body: { lang } })`.
2.  On success: `window.location.reload()`. The server will render titles/synopses in the new language.

---

## 8\. API Service Implementation Details

### 8.1 Rate Limit Utility (`src/services/rateLimiter.js`)

Create a reusable function:

```javascript
function createRateLimiter(delayMs) {
  let lastCall = 0;
  return async function rateLimitedFetch(url, options = {}) {
    const now = Date.now();
    const wait = Math.max(0, delayMs - (now - lastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetch(url, options);
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      return rateLimitedFetch(url, options); // retry once
    }
    return res;
  };
}
```

*   Jikan: `createRateLimiter(350)`
*   Shikimori: `createRateLimiter(250)`
*   AniList: no rate limiter needed (1–2 requests per sync)

### 8.2 Jikan Service (`src/services/jikan.js`)

```javascript
// fetchSeason(year, season) → anime[]
// Loops through pages: /seasons/{year}/{season}?page=N
// Returns array of objects with fields mapped to our DB schema:
// { mal_id, title_en: data.title_english || data.title,
//   title_jp: data.title_japanese,
//   synopsis_en: data.synopsis,
//   poster_url: data.images.jpg.large_image_url,
//   score_mal: data.score,
//   episodes_total: data.episodes,
//   airing_day: data.broadcast?.day?.toLowerCase(),
//   genres: JSON.stringify(data.genres.map(g => g.name)),
//   season: `${season}_${year}` }
```

### 8.3 AniList Service (`src/services/anilist.js`)

```javascript
// fetchSeason(season, year) → Map<malId, data>
// POST to https://graphql.anilist.co with the query from §1
// Loop through pages while hasNextPage
// Return Map where key = idMal, value = {
//   score_anilist: media.averageScore,
//   next_ep_num: media.nextAiringEpisode?.episode || null,
//   next_ep_at: media.nextAiringEpisode?.airingAt || null,
//   title_jp: media.title.native,  // prefer native kanji over Jikan's romaji
//   anilist_id: media.id,
//   genres: media.genres  // backup if Jikan genres are empty
// }
// Skip entries where idMal is null.
```

### 8.4 Shikimori Service (`src/services/shikimori.js`)

```javascript
// fetchBatch(malIds) → Map<malId, data>
// For each malId in array: GET https://shikimori.one/api/animes/{malId}
// Use rate limiter (250ms between requests)
// Strip HTML from description: description.replace(/<[^>]+>/g, '')
// Return Map where key = mal_id, value = {
//   title_ru: data.russian,
//   synopsis_ru: strippedDescription,
//   score_shiki: data.score
// }
// On 404: skip (anime not in Shikimori DB), set null values
// IMPORTANT: Set header 'User-Agent': 'Anidiary'
```

### 8.5 Sync Orchestrator (`src/services/sync.js`)

```javascript
// syncSeason(year, season):
//   1. const jikanAnime = await jikan.fetchSeason(year, season)
//   2. const anilistMap = await anilist.fetchSeason(season.toUpperCase(), year)
//   3. const malIds = jikanAnime.map(a => a.mal_id)
//   4. const shikiMap = await shikimori.fetchBatch(malIds)
//   5. For each anime in jikanAnime:
//        const al = anilistMap.get(anime.mal_id) || {}
//        const sh = shikiMap.get(anime.mal_id) || {}
//        Merge: { ...anime, ...al fields, ...sh fields }
//        INSERT OR REPLACE INTO anime (all columns) VALUES (...)
//   6. Log: "Synced {count} anime for {season} {year}"
//
// refreshCountdowns(year, season):
//   Lighter sync — only updates next_ep_num and next_ep_at from AniList.
//   Called more frequently (every 6 hours).
```

---

## 9\. server.js Specification

```javascript
// 1. Load .env (or just read process.env)
// 2. Initialize DB (run schema.sql if needed)
// 3. Configure Express:
//    - express.json()
//    - express.urlencoded({ extended: false })
//    - express.static('public')
//    - EJS as view engine, views directory: 'src/views'
//    - express-session with:
//        secret: process.env.SESSION_SECRET,
//        resave: false,
//        saveUninitialized: false,
//        store: new SQLiteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
//        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
// 4. Make session user available in all EJS templates:
//    app.use((req, res, next) => { res.locals.user = req.session; next(); })
// 5. Mount routes:
//    app.use('/', authRoutes)
//    app.use('/', seasonRoutes)
//    app.use('/api', apiRoutes)
// 6. Set up sync interval:
//    - refreshCountdowns() every 6 hours
//    - syncSeason() for current season every 24 hours
//    - Use getCurrentSeason() helper to determine year/season from current date
// 7. app.listen(PORT)
```

---

## 10\. Data Sync Schedule

| Task | Frequency | What it does |
| --- | --- | --- |
| `refreshCountdowns()` | Every 6 hours | Fetches only AniList `nextAiringEpisode` data, updates `next_ep_num` and `next_ep_at` in DB |
| `syncSeason()` | Every 24 hours | Full re-pull from all 3 APIs for current season. Updates scores, episode counts, new additions |
| `seed.js` (manual) | Once on deploy + when new season starts | Initial population. Run: `node scripts/seed.js 2026 winter` |

Implementation: Use `setInterval` in `server.js` (not system cron — keeps it self-contained).

```javascript
const SIX_HOURS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const { year, season } = getCurrentSeason();
  refreshCountdowns(year, season).catch(console.error);
}, SIX_HOURS);

setInterval(() => {
  const { year, season } = getCurrentSeason();
  syncSeason(year, season).catch(console.error);
}, TWENTY_FOUR_HOURS);
```

---

## 11\. Deployment Steps (exact commands)

### 11.1 DNS (Namecheap)

1.  Go to Namecheap → Domain List → `anidiary.site` → Advanced DNS
2.  Add A Record: Host `@`, Value `45.33.67.98`, TTL Automatic
3.  Add A Record: Host `www`, Value `45.33.67.98`, TTL Automatic
4.  Wait for propagation (5–30 min): `dig anidiary.site +short`

### 11.2 Server Setup (SSH into Nanode)

```bash
# Clone and install
cd /home/dmitri
git clone <your-repo-url> anidiary
cd anidiary
npm install

# Create .env
echo 'SESSION_SECRET='$(openssl rand -hex 32) > .env
echo 'PORT=3000' >> .env

# Seed initial data
node scripts/seed.js 2026 winter

# Start with PM2
pm2 start server.js --name anidiary
pm2 save
```

### 11.3 Nginx Config

Create `/etc/nginx/sites-available/anidiary`:

```nginx
server {
    listen 80;
    server_name anidiary.site www.anidiary.site;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/anidiary /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 11.4 SSL

```bash
sudo certbot --nginx -d anidiary.site -d www.anidiary.site
```

### 11.5 Backup (add to crontab)

```bash
crontab -e
# Add:
0 3 * * * cp /home/dmitri/anidiary/anidiary.db /home/dmitri/backups/anidiary-$(date +\%F).db
```

---

## 12\. Phased Build Order

### Phase 1 — MVP (target: focused week)

Build in this exact order:

1.  `npm init`, install deps, create directory structure
2.  `src/db/schema.sql` + `src/db/db.js` — database layer
3.  `src/services/rateLimiter.js` — shared utility
4.  `src/services/jikan.js` — Jikan API client
5.  `src/services/anilist.js` — AniList API client
6.  `src/services/shikimori.js` — Shikimori API client
7.  `src/services/sync.js` — merge orchestrator
8.  `scripts/seed.js` — test the full sync pipeline, verify data in DB
9.  `src/routes/auth.js` + `src/middleware/auth.js` — auth system
10.  `src/views/login.ejs` + `register.ejs` — auth pages
11.  `src/routes/season.js` + `src/views/season.ejs` + `partials/card.ejs` — main page
12.  `public/css/style.css` — full styling per §6
13.  `public/js/app.js` — countdown timers, status toggles, tabs, sorting
14.  `src/routes/api.js` — POST /api/mark + POST /api/lang
15.  `server.js` — wire everything together, add sync intervals
16.  Test locally, then deploy per §11

### Phase 2 — Polish

*   Watch history tracking (`watch_history` table, log on status change)
*   Season archive (browse past seasons via season picker)
*   Related series display on cards (data already in `related` column)
*   Search/filter by genre
*   Import from MAL/Shikimori (OAuth → pull user's anime list → populate `user_anime`)

### Phase 3 — Integrations

*   **Jellyfin:** Query `{jellyfin_url}/Items?IncludeItemTypes=Series` with API key. Match by title (fuzzy) or by provider ID if Jellyfin has MAL plugin. Update `in_jellyfin` status and `episodes_seen` automatically.
*   **Plex (optional):** Similar via Plex API or Tautulli.

### Phase 4 — If Going Public

*   Rate limiting on auth routes (`express-rate-limit`, 5 attempts per 15 min)
*   CSRF protection (`csurf` middleware)
*   Input sanitization (already mostly handled by parameterized SQL, but audit all inputs)
*   Registration: invite code or admin approval flow
*   Content Security Policy headers

---

## 13\. AI Integration Ideas (Phase 2+)

These are optional enhancements, not MVP features. All use the Claude API.

1.  **"Should I watch this?" button** — On each card, a small ✨ button. On click, sends to `/api/recommend` which calls Claude API with: the anime's synopsis + genres + scores, plus the user's watched list from `user_anime`. Prompt: "Given the user has watched and enjoyed \[list\], would they enjoy \[this anime\]? Reply in 2 sentences." Display result in a toast/popover. Cache the response in a `recommendations` table to avoid repeated API calls.
    
2.  **Smart season picks** — A third tab "AI Picks" that sends the user's full watch history to Claude and asks "Which of these \[season anime list\] would this user most enjoy? Return top 5 with brief reasoning." Run once per user per season, cache result.
    
3.  **Watch order helper** — For series with non-empty `related` field, a "Watch order?" button. Sends the related series tree to Claude, asks for recommended watch order. Useful for Fate, Monogatari, etc.
    
4.  **Russian synopsis fallback** — If Shikimori has no `description` for an anime, use Claude to translate the English synopsis to Russian. Cache in `synopsis_ru`.
    

---

## 14\. Helper: getCurrentSeason()

Used in multiple places. Place in a shared utils file or in `sync.js`:

```javascript
function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year = now.getFullYear();
  let season;
  if (month >= 1 && month <= 3) season = 'winter';
  else if (month >= 4 && month <= 6) season = 'spring';
  else if (month >= 7 && month <= 9) season = 'summer';
  else season = 'fall';
  return { year, season };
}
```

**Season format in DB:** `winter_2026`, `spring_2026`, etc. Always lowercase.

**AniList season enum mapping:** `winter → WINTER`, `spring → SPRING`, `summer → SUMMER`, `fall → FALL`.
