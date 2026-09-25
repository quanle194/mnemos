"""Deterministic fake providers for tests, CI, E2E and offline deployments.

The fake LLM implements every structured task with transparent rules operating on the JSON payload.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import re
from collections import Counter
from typing import Any

from pydantic import BaseModel

from app.domain import contradiction
from app.domain.poisoning import is_policy_like
from app.domain.text import content_tokens, jaccard, normalize, tokens, truncate
from app.providers.schemas import TASK_SCHEMAS

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")
_FAILURE_WORDS = re.compile(
    r"(?i)\b(fail(?:ed|ure|s)?|error|timed? ?out|broke|crash(?:ed)?|exception|denied|refused)\b"
)


def _short(text: str, limit: int = 120) -> str:
    return truncate(" ".join(text.split()), limit)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_SPLIT.split(text or "") if s.strip()]


class FakeLLMProvider:
    name = "fake"

    def __init__(self) -> None:
        self.calls: Counter[str] = Counter()

    async def aclose(self) -> None:
        return None

    async def generate_json(self, task: str, payload: dict[str, Any]) -> BaseModel:
        self.calls[task] += 1
        handler = getattr(self, f"_task_{task}")
        raw = handler(payload)
        return TASK_SCHEMAS[task].model_validate(raw)

    # ---- tasks -------------------------------------------------------------------------------------------
    def _task_memory_extraction(self, payload: dict[str, Any]) -> dict[str, Any]:
        exp = payload["experience"]
        eid = str(exp["id"])
        task = exp.get("task", "")
        obs, action, result = exp.get("observation", ""), exp.get("action", ""), exp.get("result", "")
        outcome = exp.get("outcome", "unknown")
        base_conf = float(exp.get("confidence", 0.7))
        importance = float(exp.get("importance", 0.5))
        meta = exp.get("metadata") or {}
        candidates: list[dict[str, Any]] = []

        explicit = meta.get("lessons") or []
        if isinstance(explicit, str):
            explicit = [explicit]
        lesson_type = meta.get("lesson_type", "lesson")
        for lesson in explicit[:5]:
            if not isinstance(lesson, str) or len(lesson.strip()) < 12:
                continue
            ltype = lesson_type
            if ltype == "lesson" and is_policy_like(lesson):
                ltype = "rule"
            candidates.append(
                {
                    "type": ltype,
                    "title": _short(lesson, 80),
                    "content": lesson.strip(),
                    "confidence": round(min(0.95, base_conf * (0.95 if outcome == "success" else 0.8)), 3),
                    "importance": importance,
                    "evidence_ids": [eid],
                    "rationale": "agent-declared lesson",
                }
            )
        if candidates:
            return {"candidates": candidates}

        total = len(" ".join([task, obs, action, result]).strip())
        if total < 40 or not (obs or action or result):
            return {"candidates": []}

        had_failure = bool(_FAILURE_WORDS.search(obs)) or bool(_FAILURE_WORDS.search(result) and outcome != "success")
        if outcome == "success":
            mtype = "lesson" if had_failure else "procedure"
            content = f"When {task[0].lower() + task[1:] if task else 'doing this task'}: "
            if obs:
                content += f"{obs.rstrip('.')}. "
            if action:
                content += f"What worked: {action.rstrip('.')}. "
            if result:
                content += f"Result: {result.rstrip('.')}."
            conf = base_conf * 0.9
            title = f"{'Lesson' if had_failure else 'How to'}: {_short(task, 90)}"
        elif outcome == "failure":
            mtype = "warning"
            content = f"When {task[0].lower() + task[1:] if task else 'doing this task'}: "
            if action:
                content += f"{action.rstrip('.')} did not work. "
            if obs or result:
                content += f"Observed: {(obs or result).rstrip('.')}."
            conf = base_conf * 0.75
            title = f"Pitfall: {_short(task, 90)}"
        else:
            mtype = "lesson"
            content = f"Partial result when {task}: {(action or obs).rstrip('.')}. {result}".strip()
            conf = base_conf * 0.6
            title = f"Partial: {_short(task, 90)}"
        candidates.append(
            {
                "type": mtype,
                "title": title,
                "content": content.strip(),
                "confidence": round(min(conf, 0.95), 3),
                "importance": importance,
                "evidence_ids": [eid],
                "rationale": f"derived from {outcome} experience",
            }
        )
        # Policy-like sentences become separate rule candidates (they will face stricter validation).
        for sent in _sentences(" ".join([obs, result]))[:3]:
            if is_policy_like(sent) and len(sent) >= 20:
                candidates.append(
                    {
                        "type": "rule",
                        "title": _short(sent, 80),
                        "content": sent,
                        "confidence": round(min(base_conf * 0.8, 0.9), 3),
                        "importance": importance,
                        "evidence_ids": [eid],
                        "rationale": "policy-like statement found in experience",
                    }
                )
        return {"candidates": candidates}

    def _task_episode_summary(self, payload: dict[str, Any]) -> dict[str, Any]:
        exps = payload["experiences"]
        last = exps[-1]
        lines = [f"{_short(last.get('task', ''), 150)} ({len(exps)} step(s))."]
        for e in exps[-8:]:
            lines.append(
                f"- [{e.get('outcome')}] {_short(e.get('action') or e.get('observation') or '', 140)}"
                f" -> {_short(e.get('result') or '', 100)}"
            )
        importance = max(float(e.get("importance", 0.5)) for e in exps)
        return {"summary": "\n".join(lines), "outcome": last.get("outcome", "unknown"), "importance": importance}

    def _task_reflection(self, payload: dict[str, Any]) -> dict[str, Any]:
        exps = payload["experiences"]
        groups: list[list[dict[str, Any]]] = []
        for e in exps:
            for g in groups:
                if jaccard(g[0]["task"], e["task"]) >= 0.5:
                    g.append(e)
                    break
            else:
                groups.append([e])
        lessons = []
        for g in groups:
            successes = [e for e in g if e.get("outcome") == "success"]
            if len(g) < 2 or not successes:
                continue
            best = successes[-1]
            failures = [e for e in g if e.get("outcome") == "failure"]
            content = (
                f"Across {len(g)} attempts at '{_short(g[0]['task'], 100)}', the approach that worked: "
                f"{(best.get('action') or best.get('result') or '').rstrip('.')}."
            )
            if failures:
                content += f" Avoid: {(failures[0].get('action') or failures[0].get('observation') or '').rstrip('.')}."
            lessons.append(
                {
                    "type": "lesson",
                    "title": f"Reflection: {_short(g[0]['task'], 90)}",
                    "content": content,
                    "confidence": round(min(0.9, 0.5 + 0.1 * len(g)), 3),
                    "importance": max(float(e.get("importance", 0.5)) for e in g),
                    "evidence_ids": [str(e["id"]) for e in g],
                    "rationale": "repeated trajectories",
                }
            )
        return {"lessons": lessons}

    def _task_pattern_summary(self, payload: dict[str, Any]) -> dict[str, Any]:
        kind = payload["kind"]
        exps = payload["experiences"]
        words = Counter(t for e in exps for t in set(content_tokens(e.get("observation") or e.get("result") or "")))
        common = [w for w, c in words.most_common(8) if c >= 2][:5]
        sample = exps[0]
        what = sample.get("observation") or sample.get("result") or sample.get("action") or ""
        content = (
            f"Recurring {kind} observed {len(exps)} times for '{_short(sample.get('task', ''), 100)}': "
            f"{what.rstrip('.')}."
        )
        if common:
            content += f" Common signals: {', '.join(common)}."
        return {
            "type": "warning" if kind == "failure" else "pattern",
            "title": f"Recurring {kind}: {_short(sample.get('task', ''), 80)}",
            "content": content,
            "confidence": round(min(0.9, 0.45 + 0.1 * len(exps)), 3),
        }

    def _task_consolidation(self, payload: dict[str, Any]) -> dict[str, Any]:
        mems = payload["memories"]
        best = max(mems, key=lambda m: (float(m.get("confidence", 0)), len(m.get("content", ""))))
        return {
            "type": best["type"],
            "title": best["title"],
            "content": best["content"],
            "confidence": round(max(float(m.get("confidence", 0)) for m in mems), 3),
        }

    def _task_generalization(self, payload: dict[str, Any]) -> dict[str, Any]:
        mems = payload["memories"]
        best = max(mems, key=lambda m: float(m.get("confidence", 0)))
        conf = min(float(m.get("confidence", 0)) for m in mems)
        return {
            "type": best["type"],
            "title": f"General: {_short(best['title'], 90)}",
            "content": f"Generally (observed in {len(mems)} contexts): {best['content']}",
            "confidence": round(min(conf, 0.85), 3),
        }

    def _task_contradiction_judgment(self, payload: dict[str, Any]) -> dict[str, Any]:
        a, b = payload["a"], payload["b"]
        sig = contradiction.detect(a, b)
        if sig.contradicts:
            rel = "supersedes" if sig.supersede_hint else "contradicts"
            return {"relation": rel, "confidence": 0.8, "explanation": sig.explanation}
        if normalize(a) == normalize(b) or jaccard(a, b) >= 0.85:
            return {"relation": "duplicate", "confidence": 0.9, "explanation": "same meaning"}
        if sig.topical_overlap >= 0.5:
            return {"relation": "supports", "confidence": 0.6, "explanation": "compatible, same topic"}
        return {"relation": "unrelated", "confidence": 0.7, "explanation": sig.explanation}


def _stem(tok: str) -> str:
    for suf in ("ing", "ed", "es", "s"):
        if len(tok) > len(suf) + 3 and tok.endswith(suf):
            return tok[: -len(suf)]
    return tok


class FakeEmbeddingProvider:
    """Feature-hashing embedder: deterministic and similarity-preserving for lexical overlap."""

    name = "fake"

    def __init__(self, dimensions: int) -> None:
        self.dimensions = dimensions

    async def aclose(self) -> None:
        return None

    def _bucket(self, feature: str) -> tuple[int, float]:
        h = hashlib.blake2b(feature.encode(), digest_size=8).digest()
        idx = int.from_bytes(h[:4], "little") % self.dimensions
        sign = 1.0 if h[4] & 1 else -1.0
        return idx, sign

    def embed_one(self, text: str) -> list[float]:
        vec = [0.0] * self.dimensions
        toks = [_stem(t) for t in content_tokens(text)] or [_stem(t) for t in tokens(text)]
        feats: list[tuple[str, float]] = [(f"w:{t}", 1.0) for t in toks]
        feats += [(f"b:{a}_{b}", 0.5) for a, b in itertools.pairwise(toks)]
        for t in toks:
            padded = f"#{t}#"
            feats += [(f"c:{padded[i : i + 3]}", 0.15) for i in range(len(padded) - 2)]
        for feat, weight in feats:
            idx, sign = self._bucket(feat)
            vec[idx] += sign * weight
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0:
            idx, _ = self._bucket("empty")
            vec[idx] = 1.0
            return vec
        return [v / norm for v in vec]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self.embed_one(t) for t in texts]
