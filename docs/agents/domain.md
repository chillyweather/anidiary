# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read ADRs under `docs/adr/` that affect the area being changed.
- If these files do not exist, proceed without requiring them.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary

Use the domain terms defined in `CONTEXT.md` in issues, tests, and implementation plans. If a required concept is absent, note the vocabulary gap instead of silently introducing competing terminology.

## Architectural decisions

Surface any conflict with an existing ADR explicitly rather than silently overriding it.
