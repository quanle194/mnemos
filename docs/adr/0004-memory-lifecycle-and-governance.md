# ADR 0004 - Memory lifecycle, layers, validation decisions and poisoning defenses

Status: accepted

## Layers
- L0 `events` (immutable), L1 `working_memories` (TTL, physically deleted on expiry - it is scratch state),
  L2 `episodes` (per session/task trajectory summary built from experiences),
  L3 `memories` with `layer=3` (semantic knowledge scoped to project/agent/session/workspace),
  L4 `memories` with `layer=4` (organizational/shared trusted knowledge, organization or workspace scope).
  Promoting to L4 requires `memory:review` and is always audited.

## Status machine
`candidate -> validated -> active -> (disputed | superseded) -> archived`; `candidate -> rejected` (terminal).
`disputed -> active` (conflict resolved in favour), `disputed -> superseded|archived`. Allowed transitions are
enforced in `app/domain/lifecycle.py`; every transition writes a `memory_versions` row and an `audit_logs` row.
Only `active` and `validated` memories appear in normal retrieval.

## Validation decisions
For each candidate: normalise + embed; fetch related active memories in the same authorised scope; classify:
- `merge` - near-duplicate (cosine >= `DEDUP_THRESHOLD` or normalised text equal): evidence is attached to the
  existing memory, confidence reinforced, candidate becomes `rejected` with `supports` relation + reason `merged`.
- `dispute` - contradiction (high topical similarity + opposite polarity / exclusive alternatives): a
  `conflicts` row is opened, candidate becomes `disputed`; existing memory stays active until resolution.
- `reject` - confidence < `MIN_CANDIDATE_CONFIDENCE`, empty/oversized, or high-risk injection from low trust.
- `require_review` - candidate is privileged (rule/constraint/decision at L4, or policy-like wording), source trust
  below `AUTO_PROMOTE_MIN_TRUST`, or injection-like content flagged: stays `candidate` with
  `review_state=pending`.
- `promote` - otherwise: `candidate -> validated -> active` in one transaction.

Conflict resolution (`POST /v1/conflicts/{id}/resolve` or dream contradiction policy):
`keep_existing` (candidate rejected), `accept_candidate` (candidate active, existing superseded with a
`supersedes` relation), `keep_both` (both active, `related_to`), `archive_both`.

## Poisoning defenses
- Retrieved/external text is always rendered as quoted data in context with an explicit non-instruction header.
- Rule-based injection detector (`app/domain/poisoning.py`) scores instruction-like patterns; flagged content can
  never auto-promote and is recorded in `metadata.flags`.
- Source trust derived from principal role and experience `source` (`agent`, `user`, `tool`, `external`);
  `external`/`tool` sources are untrusted and cannot create rule/constraint/decision memories automatically.
- Secrets are redacted before persistence and before logging.

## Feedback
Feedback never edits content. `helpful` raises utility (EMA), `irrelevant` lowers utility, `incorrect` lowers trust
and after `FEEDBACK_DISPUTE_THRESHOLD` marks memory disputed, `outdated` after threshold sets `valid_until=now`
(then lifecycle archives it), `harmful` quarantines (disputed) immediately.
