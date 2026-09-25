"""A deterministic simulated agent + environment. All counts are MEASURED from the simulation; token numbers
are ESTIMATES (chars/4) because no real LLM is invoked."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from mnemos_evals.scenarios import Family


def est_tokens(text: str) -> int:
    return math.ceil(len(text) / 4) if text else 0


@dataclass
class RunResult:
    family: str
    task: str
    success: bool
    used_memory: bool
    repeated_error: bool
    errors: int
    tool_calls: int
    est_tokens: int
    transcript: list[str] = field(default_factory=list)


def run_task(family: Family, task: str, context: str, max_steps: int = 8) -> RunResult:
    """Policy: if retrieved context contains the family's rule, apply the fix first; otherwise try the naive
    action, observe the error, diagnose (one tool call per step), then apply the fix."""
    transcript: list[str] = [f"TASK: {task}", f"CONTEXT: {context}"]
    tool_calls = 0
    errors = 0
    used_memory = family.rule_keyword.lower() in context.lower()
    if used_memory:
        transcript.append(f"ACTION: {family.fix_action}")
        tool_calls += 1
        transcript.append(f"RESULT: {family.success_result}")
        success = True
    else:
        transcript.append(f"ACTION: {family.naive_action}")
        tool_calls += 1
        transcript.append(f"RESULT: {family.error}")
        errors += 1
        for step in family.diagnosis_steps[: max_steps - 2]:
            transcript.append(f"TOOL: {step}")
            tool_calls += 1
        transcript.append(f"ACTION: {family.fix_action}")
        tool_calls += 1
        transcript.append(f"RESULT: {family.success_result}")
        success = True
    tokens = sum(est_tokens(t) for t in transcript)
    return RunResult(
        family.key,
        task,
        success,
        used_memory,
        repeated_error=errors > 0,
        errors=errors,
        tool_calls=tool_calls,
        est_tokens=tokens,
        transcript=transcript,
    )
