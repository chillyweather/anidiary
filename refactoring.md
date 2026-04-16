# Refactoring Tasks

Five fixes for correctness and security issues. Work through them in order. After each task, run `npm start` and confirm the app still boots.

---

## Task 1 — Stop wiping user tracking data on every sync

**File:** `src/db/db.js`

**Problem:** `upsertAnime` uses `INSERT OR REPLACE`. With `PRAGMA foreign_keys = ON`, REPLACE deletes the existing `anime` row before re-inserting, which cascades through `user_anime` and `watch_history` (both have `ON DELETE CASCADE` on `mal_id`). Every 24h sync silently deletes every user's `following` / `in_jellyfin` / `watched` marks for updated anime.

**Fix:** Replace the `INSERT OR REPLACE` statement in `upsertAnime` (around line 31) with a true upsert using `ON CONFLICT`:

```js
function upsertAnime(anime) {
  const stmt = db.prepare(`
    INSERT INTO anime (
      mal_id, title_en, title_jp, title_ru, synopsis_en, synopsis_ru,
      poster_url, score_mal, score_anilist, score_shiki, episodes_total,
      season, airing_status, airing_day, next_ep_num, next_ep_at,
      anilist_id, genres, related, updated_at
    ) VALUES (
      @mal_id, @title_en, @title_jp, @title_ru, @synopsis_en, @synopsis_ru,
      @poster_url, @score_mal, @score_anilist, @score_shiki, @episodes_total,
      @season, @airing_status, @airing_day, @next_ep_num, @next_ep_at,
      @anilist_id, @genres, @related, unixepoch()
    )
    ON CONFLICT(mal_id) DO UPDATE SET
      title_en       = excluded.title_en,
      title_jp       = excluded.title_jp,
      title_ru       = excluded.title_ru,
      synopsis_en    = excluded.synopsis_en,
      synopsis_ru    = excluded.synopsis_ru,
      poster_url     = excluded.poster_url,
      score_mal      = excluded.score_mal,
      score_anilist  = excluded.score_anilist,
      score_shiki    = excluded.score_shiki,
      episodes_total = excluded.episodes_total,
      season         = excluded.season,
      airing_status  = excluded.airing_status,
      airing_day     = excluded.airing_day,
      next_ep_num    = excluded.next_ep_num,
      next_ep_at     = excluded.next_ep_at,
      anilist_id     = excluded.anilist_id,
      genres         = excluded.genres,
      related        = excluded.related,
      updated_at     = unixepoch()
  `);
  return stmt.run(anime);
}
```

**Verify:** After running a sync, rows in `user_anime` must still exist. Quick check:
```bash
sqlite3 anidiary.db "SELECT COUNT(*) FROM user_anime;"
# run sync, then re-run the same query — count should not drop
```

---

## Task 2 — Rate limit `/login` and `/register`

**Files:** `package.json`, `src/routes/auth.js`

**Problem:** No limit on login attempts. bcrypt rounds=12 is slow (~200ms), so unlimited requests are both a brute-force and a CPU-DoS vector.

**Fix:**

1. Install the dependency:
   ```bash
   npm install express-rate-limit
   ```

2. In `src/routes/auth.js`, at the top after the existing `require`s, add:
   ```js
   const rateLimit = require('express-rate-limit');

   const authLimiter = rateLimit({
     windowMs: 15 * 60 * 1000,
     max: 10,
     standardHeaders: true,
     legacyHeaders: false,
     message: { error: 'Too many attempts, try again later' }
   });
   ```

3. Apply it to both POST handlers. Change:
   ```js
   router.post('/login', async (req, res) => {
   router.post('/register', async (req, res) => {
   ```
   to:
   ```js
   router.post('/login', authLimiter, async (req, res) => {
   router.post('/register', authLimiter, async (req, res) => {
   ```

**Verify:** Hit `/login` with wrong credentials 11 times quickly — the 11th should return 429.

---

## Task 3 — Make `/logout` a POST

**Files:** `src/routes/auth.js`, `src/views/*.ejs` (any template that links to `/logout`)

**Problem:** `GET /logout` with no token means `<img src="/logout">` on any page logs the user out.

**Fix:**

1. In `src/routes/auth.js`, change:
   ```js
   router.get('/logout', (req, res) => {
   ```
   to:
   ```js
   router.post('/logout', (req, res) => {
   ```

2. Find every logout link in the EJS templates. Grep first:
   ```
   grep -rn "/logout" src/views/
   ```

3. Replace each `<a href="/logout">Logout</a>` with a form:
   ```html
   <form method="POST" action="/logout" class="logout-form">
     <button type="submit" class="logout-btn">Logout</button>
   </form>
   ```

4. If existing CSS styles the logout anchor, add matching rules for `.logout-btn` in `public/css/style.css` so it visually matches (reset `background`, `border`, `padding`, use the same color/font as the old link).

**Verify:** Clicking Logout in the UI still logs out. Visiting `GET /logout` in the browser returns 404 (or 405 via the default handler) and does NOT destroy the session.

---

## Task 4 — Fix login timing oracle

**File:** `src/routes/auth.js`

**Problem:** When the username doesn't exist, the handler returns before `bcrypt.compare` runs. Response time leaks which usernames exist.

**Fix:** In the `POST /login` handler, replace the block:

```js
const user = getUserByUsername(username);

if (!user) {
  return res.render('login', { error: 'Invalid username or password' });
}

const match = await bcrypt.compare(password, user.password_hash);

if (!match) {
  return res.render('login', { error: 'Invalid username or password' });
}
```

with:

```js
const user = getUserByUsername(username);

// Precomputed hash of a random string — compared against when user is missing
// so response time is constant whether or not the username exists.
const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8.FQYB1YvQm0gK6lL0m7fQpF5u6bYu';
const hashToCompare = user ? user.password_hash : DUMMY_HASH;

const match = await bcrypt.compare(password, hashToCompare);

if (!user || !match) {
  return res.render('login', { error: 'Invalid username or password' });
}
```

**Verify:** `time curl -d 'username=nope&password=x' http://localhost:3000/login` should take roughly the same time as `time curl -d 'username=<real>&password=wrong' http://localhost:3000/login` (both ~200ms, within ~20ms of each other).

---

## Task 5 — Generate a persistent dev session secret

**File:** `server.js`

**Problem:** `SESSION_SECRET || 'dev-secret-change-in-production'` means every dev instance shares one secret.

**Fix:**

1. At the top of `server.js`, after the existing `require`s, add:
   ```js
   const fs = require('fs');
   const crypto = require('crypto');
   ```

2. Replace the block:
   ```js
   const SESSION_SECRET = process.env.SESSION_SECRET;

   if (!SESSION_SECRET && IS_PRODUCTION) {
     throw new Error('SESSION_SECRET is required in production');
   }
   ```
   with:
   ```js
   function loadSessionSecret() {
     if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
     if (IS_PRODUCTION) {
       throw new Error('SESSION_SECRET is required in production');
     }
     const secretPath = path.join(__dirname, '.session-secret');
     if (fs.existsSync(secretPath)) {
       return fs.readFileSync(secretPath, 'utf8').trim();
     }
     const generated = crypto.randomBytes(32).toString('hex');
     fs.writeFileSync(secretPath, generated, { mode: 0o600 });
     return generated;
   }

   const SESSION_SECRET = loadSessionSecret();
   ```

3. In the `session({...})` config, change:
   ```js
   secret: SESSION_SECRET || 'dev-secret-change-in-production',
   ```
   to:
   ```js
   secret: SESSION_SECRET,
   ```

4. Add `.session-secret` to `.gitignore` (append a new line if not present).

**Verify:** Start the app with no `SESSION_SECRET` env var. A `.session-secret` file appears in the project root. Restart — same secret is reused (sessions survive restart).

---

## Done

Run `npm start`, log in, mark an anime, log out, log back in. All five fixes should be transparent in the UI — no visible changes except the logout button becoming a form button.
