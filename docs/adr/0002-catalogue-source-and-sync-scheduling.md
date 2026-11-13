# ADR 0002: Catalogue Source and Sync Scheduling

- Status: Accepted
- Date: 2026-11-13
- Decision owners: Anidiary maintainers

## Context

Season data came from Jikan (the season list, MAL scores, broadcast day), AniList
(countdowns, AniList scores) and Shikimori (Russian titles, synopses and scores).
Jikan was the catalogue: when it failed, AniList filled the list only as a
fallback. Relations were fetched lazily from Jikan when the detail modal opened,
so the modal waited on a third party and retried on every open while Jikan was
down. Jikan has been unreachable for whole days at a time.

Synchronization ran on two fixed timers (countdowns every 6h, the current season
every 24h). Nothing ran at startup, every restart reset the timers, the next and
previous seasons were never refreshed, and a new season waited up to a day after
rollover. A season sync kept a stored countdown whenever AniList reported none,
so finished titles kept a stale "next episode" forever (issue #19).

## Decision

### Sources

- AniList is the catalogue source. It supplies the season list, titles, English
  synopsis, poster, episode count, airing status, countdown, AniList score,
  genres, release format, popularity and relations.
- Jikan is an optional enricher. It supplies the MAL score and broadcast day, and
  is a fallback for titles, synopsis, poster, episodes, genres and format when
  AniList lacks them.
- Shikimori is an enricher for the Russian title, synopsis and score. It is
  queried through its GraphQL API on `shikimori.io`, 50 titles per request. Its
  id filter takes Shikimori's own ids, so a response row is used only when its
  `malId` is one that was requested.
- When AniList fails or returns an incomplete season, titles only Jikan listed are
  added so the season is still complete. Such a title keeps the season it already
  has in the database, because the catalogue did not place it.
- Relations are taken from AniList during the season sync and stored with the
  anime, keyed by MAL id (entries without a MAL id are dropped). An explicit edge
  list, even an empty one, replaces the stored relations; a missing one keeps
  them. The detail API only reads the database.

### Merge rule

A provider that failed or did not return a title says nothing about it, so the
stored value is kept. A provider that answered for a title and reported no value
is authoritative where absence is meaningful: when AniList answered, a null next
episode clears the stored countdown, and the airing status follows AniList. Other
fields (scores, titles, synopses, poster, relations) keep their stored value when
the incoming value is null. Shared Jellyfin availability is never written by a
sync.

### Scheduling

- `sync_state` stores, per job (a season key such as `fall_2026`, or
  `countdowns`), the last attempt, the last complete run, the last status
  (`complete`, `partial`, `failed`), the consecutive failure count and the last
  error. The sync service records every run itself, so the scheduler, the CLI
  seed scripts and seed-on-visit are all tracked.
- A tick 30 seconds after startup and then every 10 minutes runs at most one
  overdue job, never overlapping itself:
  - the current season when its last complete sync is older than 12h;
  - countdowns every 6h, or within 30 minutes once a known next-episode time has
    passed; the refresh covers every airing title, not-yet-aired titles due
    within a day, and every unfinished title a user follows or watches,
    regardless of season;
  - the next season when older than 24h;
  - the previous season when older than 24h while it still has airing titles.
  - A current or next season that was never synced is overdue immediately. A run
    that was partial or failed (seasons and countdowns alike) is retried after 1h,
    doubling per consecutive failure up to 6h; this backoff is checked before the
    normal cadence.
- Season syncs run one at a time through a single queue shared by the scheduler,
  page views and the CLI.
- Visiting a season with no rows that was never synced successfully queues a
  background sync (at most three seasons may wait) and shows a "fetching" state
  that refreshes itself. After a failure the page shows when the next automatic
  attempt is due and does not start one before then. A CSRF-protected retry
  button may bypass that backoff, at most once per five minutes per season.
  Seasons more than one season ahead are not fetched.
- Provider request timeouts cover reading the response body, not only the
  headers.

## Consequences

The season list and modal no longer depend on Jikan being reachable; while it is
down, MAL scores and broadcast days are missing for new titles and the season is
recorded as partial, so it is retried with backoff. Countdowns follow AniList
promptly after each episode airs, and finished titles lose their stale countdown.
Restarts no longer delay synchronization. Relations exist only for titles synced
after this change; older rows gain them on their season's next sync. Season order
defaults to AniList popularity, which exists before any score does.
