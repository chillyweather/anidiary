# ADR 0001: Tracking and Jellyfin Availability

- Status: Accepted
- Date: 2026-06-19
- Amended: 2026-10-03 (added the `watching` state; see Amendments)
- Decision owners: Anidiary maintainers

## Context

Anidiary currently models `following`, `in_jellyfin`, and `watched` as mutually
exclusive per-user statuses. The schema also contains `episodes_seen` and
`watch_history`, although the product has no episode-progress or watch-history
workflow. Jellyfin availability is a household-level fact, so representing it as a
personal tracking state prevents it from coexisting with a user's actual tracking
state.

## Decision

- Anidiary will not integrate with the Jellyfin API or synchronize episode progress.
- The product will remove `episodes_seen` and `watch_history`.
- "In Jellyfin" means that an anime exists in the household's shared Jellyfin library.
- Jellyfin availability is one shared flag per anime. Either authenticated user may
  toggle it.
- Personal tracking remains one mutually exclusive state per user: no state,
  `following`, `watching`, or `watched`.
- `following` means the user finds the anime interesting and intends to watch it
  later. `watching` means the user is watching it now. `watched` means the user
  has finished it.
- The Following and Watching lists each contain only anime in that exact state,
  including anime from other seasons. Watched anime appear in neither list.
- Shared Jellyfin availability is independent of personal tracking and may coexist
  with any personal state.

## Migration

For each existing per-user `in_jellyfin` row, migration sets the corresponding
anime's shared Jellyfin availability flag. It then removes those per-user rows while
leaving `following` and `watched` rows unchanged.

Migration must stop without modifying the schema or discarding data when either
condition is true:

- any `user_anime.episodes_seen` value is greater than zero;
- any row exists in `watch_history`.

## Consequences

The data model matches the current product workflow and no longer implies planned
episode-level tracking. Status updates become simpler, while Jellyfin availability
requires a separate authenticated write contract and shared UI state. A future
episode-progress or history feature requires a new product decision and schema
rather than reusing dormant fields.

## Amendments

### 2026-10-03: `watching` state and exact-state lists

The original decision allowed only `following` and `watched`, and the Following
list contained every anime with any personal state. That left no way to mark an
anime as in progress, and marking a followed anime as watched kept it in a list
meant for anime to watch in the future.

Personal tracking now has a third mutually exclusive state, `watching`. Migration
v3 rebuilds `user_anime` so its status check accepts `following`, `watching`, and
`watched`; existing rows are carried over unchanged. `watching` records only that
the anime is in progress and does not reintroduce episode-level progress.
