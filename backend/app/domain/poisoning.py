"""Rule-based prompt-injection / memory-poisoning detector.

The detector is intentionally conservative: it never rewrites content, it only scores and flags it so that the
validation pipeline can refuse automatic promotion and route to review.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_RULES: list[tuple[str, float, re.Pattern[str]]] = [
    ("override_instructions", 0.9, re.compile(
        r"(?i)\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|earlier|system)\b.{0,30}"
        r"\b(instructions?|rules?|prompts?|guidelines?|polic(?:y|ies))")),
    ("role_hijack", 0.7, re.compile(r"(?i)\b(you are now|act as|pretend to be|from now on,? you)\b")),
    ("system_prompt_ref", 0.6, re.compile(r"(?i)\b(system prompt|developer message|hidden instructions?)\b")),
    ("exfiltration", 0.9, re.compile(
        r"(?i)\b(send|post|upload|exfiltrate|leak|forward)\b.{0,60}\b(api[_ -]?keys?|secrets?|credentials?|"
        r"passwords?|tokens?|env(?:ironment)? variables?)\b")),
    ("remote_exec", 0.8, re.compile(r"(?i)(curl|wget)\s+[^|;]*\|\s*(ba|z)?sh\b")),
    ("disable_safety", 0.8, re.compile(
        r"(?i)\b(disable|bypass|turn off|skip)\b.{0,30}\b(auth(?:entication|orization)?|security|safety|"
        r"verification|validation|tls|ssl|audit(?:ing)?|guardrails?)\b")),
    ("absolute_mandate", 0.35, re.compile(r"(?i)\b(always|never|must)\b.{0,40}\b(obey|comply|follow this|trust)\b")),
    ("tag_injection", 0.6, re.compile(r"(?i)</?(system|assistant|instructions?)>|\[\s*(system|INST)\s*\]")),
    ("destructive", 0.7, re.compile(r"(?i)\b(rm\s+-rf\s+/|drop\s+database|delete\s+all\s+(?:memories|data))\b")),
]

POLICY_LIKE = re.compile(r"(?i)\b(always|never|must|must not|mandatory|policy|required to|forbidden)\b")


@dataclass(frozen=True)
class InjectionAssessment:
    score: float
    flags: list[str] = field(default_factory=list)

    @property
    def is_suspicious(self) -> bool:
        return self.score >= 0.5

    @property
    def is_high_risk(self) -> bool:
        return self.score >= 0.85


def assess_injection(*texts: str | None) -> InjectionAssessment:
    joined = "\n".join(t for t in texts if t)
    flags: list[str] = []
    score = 0.0
    for name, weight, pattern in _RULES:
        if pattern.search(joined):
            flags.append(name)
            # combine as independent probabilities
            score = 1 - (1 - score) * (1 - weight)
    return InjectionAssessment(score=round(score, 4), flags=flags)


def is_policy_like(text: str) -> bool:
    return bool(POLICY_LIKE.search(text))
