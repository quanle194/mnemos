"""Promotion policy: a pure, traceable decision function (see ADR 0004)."""

from __future__ import annotations

from dataclasses import dataclass, field

from app.domain.enums import PRIVILEGED_TYPES, MemoryType, ValidationDecision
from app.domain.poisoning import InjectionAssessment

# Types that describe observations rather than prescriptions: never checked for polarity contradictions.
OBSERVATIONAL_TYPES = frozenset({MemoryType.WARNING, MemoryType.FAILURE, MemoryType.SUCCESS, MemoryType.PATTERN,
                                 MemoryType.CONTEXT, MemoryType.RELATIONSHIP})


@dataclass(frozen=True)
class PolicyConfig:
    min_candidate_confidence: float = 0.3
    auto_promote_min_confidence: float = 0.55
    auto_promote_min_trust: float = 0.5
    privileged_min_confidence: float = 0.7


@dataclass(frozen=True)
class CandidateFacts:
    type: MemoryType
    layer: int
    scope_type: str
    confidence: float
    trust: float
    injection: InjectionAssessment
    policy_like: bool
    has_success_evidence: bool
    duplicate_of: str | None = None
    contradicts: str | None = None
    created_by_reviewer: bool = False


@dataclass
class PolicyResult:
    decision: ValidationDecision
    reasons: list[str] = field(default_factory=list)


def decide(f: CandidateFacts, cfg: PolicyConfig) -> PolicyResult:
    D = ValidationDecision
    if f.injection.is_high_risk and f.trust < cfg.auto_promote_min_trust:
        return PolicyResult(D.REJECT, [f"high-risk injection patterns {f.injection.flags} from untrusted source"])
    if f.confidence < cfg.min_candidate_confidence:
        return PolicyResult(D.REJECT, [f"confidence {f.confidence:.2f} below {cfg.min_candidate_confidence}"])
    if f.injection.is_suspicious:
        return PolicyResult(D.REQUIRE_REVIEW, [f"instruction-like content flagged {f.injection.flags}"])
    if f.duplicate_of:
        return PolicyResult(D.MERGE, [f"near-duplicate of {f.duplicate_of}"])
    if f.contradicts:
        return PolicyResult(D.DISPUTE, [f"contradicts {f.contradicts}"])
    shared_scope = f.layer == 4 or f.scope_type in ("organization", "workspace")
    privileged = f.type in PRIVILEGED_TYPES
    if privileged and shared_scope and not f.created_by_reviewer:
        return PolicyResult(D.REQUIRE_REVIEW, ["privileged memory type at shared/organizational scope"])
    if privileged or (f.policy_like and f.type not in PRIVILEGED_TYPES):
        reasons = []
        if f.trust < cfg.auto_promote_min_trust:
            reasons.append(f"source trust {f.trust:.2f} below {cfg.auto_promote_min_trust}")
        if f.confidence < cfg.privileged_min_confidence:
            reasons.append(f"confidence {f.confidence:.2f} below privileged minimum {cfg.privileged_min_confidence}")
        if not f.has_success_evidence and not f.created_by_reviewer:
            reasons.append("policy-like knowledge requires a successful experience as evidence")
        if reasons:
            return PolicyResult(D.REQUIRE_REVIEW, reasons)
        return PolicyResult(D.PROMOTE, ["privileged/policy-like candidate met stronger evidence requirements"])
    if f.trust < cfg.auto_promote_min_trust:
        return PolicyResult(D.REQUIRE_REVIEW, [f"source trust {f.trust:.2f} below {cfg.auto_promote_min_trust}"])
    if f.confidence < cfg.auto_promote_min_confidence:
        return PolicyResult(D.REQUIRE_REVIEW, [f"confidence {f.confidence:.2f} below auto-promote minimum"])
    return PolicyResult(D.PROMOTE, ["passed validation"])
