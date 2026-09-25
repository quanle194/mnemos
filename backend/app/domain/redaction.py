"""Secret redaction applied before persistence and before logs are emitted."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any

REDACTED = "[REDACTED]"

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{12,}=*")),
    ("openai_key", re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{16,}\b")),
    ("mnemos_key", re.compile(r"\bmnm_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("slack_token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("url_credentials", re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@]+):[^\s@/]+@")),
    (
        "assignment",
        re.compile(
            r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)"
            r"(\s*[:=]\s*|\s+is\s+)(\"[^\"]+\"|'[^']+'|[^\s,;]+)"
        ),
    ),
]

SENSITIVE_KEYS = re.compile(
    r"(?i)^(password|passwd|secret|api[_-]?key|token|access[_-]?token|authorization|private[_-]?key|client[_-]?secret)$"
)

RedactionHook = Callable[[str], str]
_extra_hooks: list[RedactionHook] = []


def register_redaction_hook(hook: RedactionHook) -> None:
    """Configurable hook for deployment-specific redaction rules."""
    _extra_hooks.append(hook)


def redact_text(text: str) -> str:
    if not text:
        return text
    out = text
    for name, pattern in _PATTERNS:
        if name == "url_credentials":
            out = pattern.sub(lambda m: f"{m.group(1)}:{REDACTED}@", out)
        elif name == "assignment":
            out = pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", out)
        else:
            out = pattern.sub(REDACTED, out)
    for hook in _extra_hooks:
        out = hook(out)
    return out


def redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return {
            k: (REDACTED if isinstance(k, str) and SENSITIVE_KEYS.match(k) and v else redact_value(v))
            for k, v in value.items()
        }
    if isinstance(value, list | tuple):
        return [redact_value(v) for v in value]
    return value
