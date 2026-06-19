# ADR 0001: Tracking and Jellyfin Availability

- Status: Accepted
- Date: 2026-06-19
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
  `following`, or `watched`.
- Shared Jellyfin availability is independent of personal tracking and may coexist
  with either personal state.

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
