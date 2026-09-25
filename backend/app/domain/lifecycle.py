"""Memory status state machine."""

from __future__ import annotations

from app.domain.enums import MemoryStatus as S


class InvalidTransitionError(ValueError):
    def __init__(self, current: S, target: S) -> None:
        super().__init__(f"invalid memory status transition {current} -> {target}")
        self.current = current
        self.target = target


ALLOWED_TRANSITIONS: dict[S, frozenset[S]] = {
    S.CANDIDATE: frozenset({S.VALIDATED, S.ACTIVE, S.REJECTED, S.DISPUTED}),
    S.VALIDATED: frozenset({S.ACTIVE, S.REJECTED, S.DISPUTED, S.ARCHIVED}),
    S.ACTIVE: frozenset({S.DISPUTED, S.SUPERSEDED, S.ARCHIVED}),
    S.DISPUTED: frozenset({S.ACTIVE, S.SUPERSEDED, S.ARCHIVED, S.REJECTED}),
    S.SUPERSEDED: frozenset({S.ARCHIVED}),
    S.ARCHIVED: frozenset({S.ACTIVE}),  # explicit, audited restore by reviewer
    S.REJECTED: frozenset(),
}


def can_transition(current: S, target: S) -> bool:
    return target in ALLOWED_TRANSITIONS[current]


def assert_transition(current: S, target: S) -> None:
    if not can_transition(current, target):
        raise InvalidTransitionError(current, target)
