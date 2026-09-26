"""Asynchronous dreaming: reflection, deduplication, pattern, contradiction, generalization, compression.

Guardrails (docs/04): never deletes evidence/history; consolidation creates versions + relations; LLM output is
schema-validated; re-running the same input window is detected via `window_hash`; progress is checkpointed so a
crashed job resumes without re-applying finished clusters.
"""

from __future__ import annotations

import hashlib
import time
import uuid
from collections import defaultdict
from typing import Any

import numpy as np
import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from app.db.base import utcnow
from app.db.models import Conflict, DreamJob, Experience, Memory, MemoryEvidence, SchedulerState, Workspace
from app.domain import contradiction
from app.domain.enums import (
    DreamMode,
    DreamStatus,
    EvidenceSourceType,
    MemoryStatus,
    MemoryType,
    RelationType,
    ReviewState,
    ScopeType,
)
from app.domain.permissions import Permission
from app.domain.policy import OBSERVATIONAL_TYPES
from app.domain.text import content_hash
from app.jobs import queue
from app.modules import audit, conflict_service, memory_service, tenancy_service
from app.modules.ctx import Ctx
from app.modules.experience_service import _exp_payload
from app.modules.memory_service import EvidenceInput
from app.modules.tenancy_service import Refs
from app.observability import metrics
from app.providers.base import structured
from app.providers.schemas import ContradictionOut, ReflectionOut, SynthesisOut
from app.tenancy import NotFound

log = structlog.get_logger(__name__)
EXPERIENCE_MODES = {DreamMode.REFLECTION, DreamMode.PATTERN}


def _vec(m: Memory) -> list[float]:
    return [float(x) for x in (m.embedding if m.embedding is not None else [])]


def _hash(*parts: object) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


async def _fingerprint(ctx: Ctx, workspace_id: uuid.UUID, mode: DreamMode) -> tuple[str, dict[str, Any]]:
    """Input-window fingerprint used to detect re-processing of an identical window."""
    if mode in EXPERIENCE_MODES:
        last = await _last_checkpoint(ctx, workspace_id, mode)
        q = select(Experience.id).where(Experience.workspace_id == workspace_id)
        if last:
            q = q.where(Experience.id > uuid.UUID(last))
        ids = (await ctx.db.scalars(q.order_by(Experience.id).limit(ctx.settings.dream_window_limit))).all()
        return _hash(mode.value, *ids), {"since_experience_id": last, "experience_count": len(ids)}
    row = (
        await ctx.db.execute(
            select(func.count(), func.max(Memory.updated_at)).where(
                Memory.workspace_id == workspace_id,
                Memory.status.in_([MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value]),
            )
        )
    ).one()
    return _hash(mode.value, row[0], row[1]), {
        "active_memories": int(row[0]),
        "max_updated_at": row[1].isoformat() if row[1] else None,
    }


async def _last_checkpoint(ctx: Ctx, workspace_id: uuid.UUID, mode: DreamMode) -> str | None:
    st = await ctx.db.scalar(
        select(SchedulerState).where(
            SchedulerState.workspace_id == workspace_id, SchedulerState.task == f"dream:{mode.value}"
        )
    )
    return st.counters_json.get("last_experience_id") if st else None


async def request_dream(
    ctx: Ctx, workspace_id: uuid.UUID, mode: DreamMode, trigger_type: str = "manual", dedupe_window: bool | None = None
) -> tuple[DreamJob, bool]:
    """Create a dream job. Returns (job, created). Scheduled triggers dedupe identical input windows."""
    if trigger_type == "manual":
        ctx.principal.require(Permission.DREAM_RUN)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    fingerprint, window = await _fingerprint(ctx, ws.id, mode)
    dedupe = trigger_type != "manual" if dedupe_window is None else dedupe_window
    job = DreamJob(
        organization_id=ws.organization_id,
        workspace_id=ws.id,
        mode=mode.value,
        trigger_type=trigger_type,
        window_hash=fingerprint if dedupe else None,
        input_window_json=window,
        requested_by_id=ctx.principal.actor_id,
    )
    if dedupe:
        existing = await ctx.db.scalar(
            select(DreamJob).where(
                DreamJob.workspace_id == ws.id, DreamJob.mode == mode.value, DreamJob.window_hash == fingerprint
            )
        )
        if existing:
            return existing, False
    ctx.db.add(job)
    try:
        async with ctx.db.begin_nested():
            await ctx.db.flush()
    except IntegrityError:
        existing = await ctx.db.scalar(
            select(DreamJob).where(
                DreamJob.workspace_id == ws.id, DreamJob.mode == mode.value, DreamJob.window_hash == fingerprint
            )
        )
        assert existing is not None
        return existing, False
    await queue.enqueue(
        ctx.db,
        kind=queue.RUN_DREAM,
        payload={"dream_id": str(job.id)},
        idempotency_key=f"dream:{job.id}",
        organization_id=ws.organization_id,
        workspace_id=ws.id,
        max_attempts=ctx.settings.job_max_attempts,
    )
    ctx.wake_workers = True
    await audit.record(
        ctx,
        "dream.request",
        "dream_job",
        job.id,
        workspace_id=ws.id,
        after={"mode": mode.value, "trigger": trigger_type, "window": window},
    )
    return job, True


async def get_dream(ctx: Ctx, dream_id: uuid.UUID) -> DreamJob:
    ctx.principal.require(Permission.MEMORY_READ)
    d = await ctx.db.scalar(
        select(DreamJob).where(DreamJob.id == dream_id, DreamJob.organization_id == ctx.principal.organization_id)
    )
    if d is None or not ctx.principal.can_access_workspace(d.workspace_id):
        raise NotFound("dream job not found")
    return d


async def list_dreams(ctx: Ctx, workspace_id: uuid.UUID, limit: int, cursor: uuid.UUID | None) -> list[DreamJob]:
    ctx.principal.require(Permission.MEMORY_READ)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    q = select(DreamJob).where(DreamJob.workspace_id == ws.id)
    if cursor:
        q = q.where(DreamJob.id < cursor)
    return list((await ctx.db.scalars(q.order_by(DreamJob.id.desc()).limit(limit))).all())


# ============================================================================ execution
async def run_dream(ctx: Ctx, dream_id: uuid.UUID) -> dict[str, Any]:
    job = await ctx.db.scalar(
        select(DreamJob)
        .where(DreamJob.id == dream_id, DreamJob.organization_id == ctx.principal.organization_id)
        .with_for_update()
    )
    if job is None:
        return {"skipped": "dream not found"}
    if job.status == DreamStatus.SUCCEEDED.value:
        return {"skipped": "already succeeded"}
    job.status = DreamStatus.RUNNING.value
    job.started_at = job.started_at or utcnow()
    job.error = None
    await ctx.commit()
    t0 = time.perf_counter()
    mode = DreamMode(job.mode)
    runner = _RUNNERS[mode]
    try:
        result = await runner(ctx, job)
    except Exception as exc:
        await ctx.db.rollback()
        job = await ctx.db.get(DreamJob, dream_id, populate_existing=True)
        assert job is not None
        job.status = DreamStatus.FAILED.value
        job.error = f"{type(exc).__name__}: {exc}"[:2000]
        await ctx.commit()
        raise
    duration = time.perf_counter() - t0
    job = await ctx.db.get(DreamJob, dream_id, populate_existing=True)
    assert job is not None
    result["duration_ms"] = round(duration * 1000, 1)
    job.result_json = result
    job.status = DreamStatus.SUCCEEDED.value
    job.completed_at = utcnow()
    await audit.record(
        ctx,
        "dream.complete",
        "dream_job",
        job.id,
        workspace_id=job.workspace_id,
        after={"mode": job.mode, "stats": result.get("stats", {})},
    )
    metrics.DREAM_DURATION.labels(mode=job.mode).observe(duration)
    await ctx.commit()
    return {"mode": job.mode, "stats": result.get("stats", {})}


async def _checkpoint(ctx: Ctx, job: DreamJob, **updates: Any) -> None:
    job.checkpoint_json = {**job.checkpoint_json, **updates}
    await ctx.commit()


async def _refs(ctx: Ctx, workspace_id: uuid.UUID, project_id: uuid.UUID | None = None) -> Refs:
    ws = await ctx.db.get(Workspace, workspace_id)
    assert ws is not None
    return Refs(ws, project_id, None, None)


async def _window_experiences(ctx: Ctx, job: DreamJob, mode: DreamMode, lookback: bool) -> list[Experience]:
    q = select(Experience).where(Experience.workspace_id == job.workspace_id)
    if not lookback:
        since = job.checkpoint_json.get("last_experience_id") or await _last_checkpoint(ctx, job.workspace_id, mode)
        if since:
            q = q.where(Experience.id > uuid.UUID(since))
        q = q.order_by(Experience.id).limit(ctx.settings.dream_window_limit)
    else:
        q = q.order_by(Experience.id.desc()).limit(ctx.settings.dream_window_limit)
    rows = list((await ctx.db.scalars(q)).all())
    return sorted(rows, key=lambda e: e.id)


async def _save_mode_checkpoint(ctx: Ctx, job: DreamJob, mode: DreamMode, last_id: uuid.UUID | None) -> None:
    if last_id is None:
        return
    st = await ctx.db.scalar(
        select(SchedulerState)
        .where(SchedulerState.workspace_id == job.workspace_id, SchedulerState.task == f"dream:{mode.value}")
        .with_for_update()
    )
    if st is None:
        st = SchedulerState(
            organization_id=job.organization_id,
            workspace_id=job.workspace_id,
            task=f"dream:{mode.value}",
            counters_json={},
        )
        ctx.db.add(st)
    prev = st.counters_json.get("last_experience_id")
    if prev is None or uuid.UUID(prev) < last_id:
        st.counters_json = {**st.counters_json, "last_experience_id": str(last_id)}
    st.last_run_at = utcnow()
    st.updated_at = utcnow()


async def _propose_candidate(
    ctx: Ctx,
    job: DreamJob,
    *,
    type: MemoryType,
    title: str,
    content: str,
    confidence: float,
    importance: float,
    evidence: list[EvidenceInput],
    scope: ScopeType,
    project_id: uuid.UUID | None,
    trust: float,
    review_state: ReviewState = ReviewState.NONE,
    extra_meta: dict[str, Any] | None = None,
) -> Memory | None:
    """Create a candidate (goes through normal validation). Skips exact duplicates of known knowledge."""
    h = content_hash(content)
    dup = await ctx.db.scalar(
        select(Memory.id)
        .where(
            Memory.workspace_id == job.workspace_id,
            Memory.content_hash == h,
            Memory.status.notin_([MemoryStatus.REJECTED.value]),
        )
        .limit(1)
    )
    if dup:
        return None
    refs = await _refs(ctx, job.workspace_id, project_id)
    m = await memory_service.create_memory(
        ctx,
        refs=refs,
        type=type,
        scope_type=scope,
        title=title,
        content=content,
        status=MemoryStatus.CANDIDATE,
        confidence=confidence,
        trust=trust,
        importance=importance,
        evidence=evidence,
        reason=f"proposed by {job.mode} dream {job.id}",
        review_state=review_state,
        metadata={"dream": {"id": str(job.id), "mode": job.mode}, **(extra_meta or {})},
    )
    if review_state == ReviewState.NONE:
        await queue.enqueue(
            ctx.db,
            kind=queue.VALIDATE_CANDIDATE,
            payload={"memory_id": str(m.id)},
            idempotency_key=f"validate:{m.id}",
            organization_id=m.organization_id,
            workspace_id=m.workspace_id,
            max_attempts=ctx.settings.job_max_attempts,
        )
        ctx.wake_workers = True
    return m


def _common_project(exps: list[Experience]) -> uuid.UUID | None:
    projects = {e.project_id for e in exps}
    return projects.pop() if len(projects) == 1 else None


async def _reflection(ctx: Ctx, job: DreamJob) -> dict[str, Any]:
    exps = await _window_experiences(ctx, job, DreamMode.REFLECTION, lookback=False)
    proposals: list[str] = []
    if len(exps) >= 2:
        out = await structured(
            ctx.container.llm, "reflection", {"experiences": [_exp_payload(e) for e in exps]}, ReflectionOut
        )
        by_id = {str(e.id): e for e in exps}
        for lesson in out.lessons:
            ev_exps = [by_id[i] for i in lesson.evidence_ids if i in by_id]
            if not ev_exps:
                continue  # never accept ungrounded lessons
            project = _common_project(ev_exps)
            m = await _propose_candidate(
                ctx,
                job,
                type=lesson.type,
                title=lesson.title,
                content=lesson.content,
                confidence=lesson.confidence,
                importance=lesson.importance,
                evidence=[
                    EvidenceInput(EvidenceSourceType.EXPERIENCE, str(e.id), "derived_from", 1.0, e.task)
                    for e in ev_exps
                ],
                scope=ScopeType.PROJECT if project else ScopeType.WORKSPACE,
                project_id=project,
                trust=min(e.source_trust for e in ev_exps),
            )
            if m:
                proposals.append(str(m.id))
    await _save_mode_checkpoint(ctx, job, DreamMode.REFLECTION, exps[-1].id if exps else None)
    return {"proposals": proposals, "stats": {"experiences": len(exps), "proposed": len(proposals)}}


def _clusters(vectors: np.ndarray, threshold: float, groups: list[Any] | None = None) -> list[list[int]]:
    """Greedy single-pass clustering on cosine similarity (vectors are L2-normalised or get normalised)."""
    if len(vectors) == 0:
        return []
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1
    v = vectors / norms
    sims = v @ v.T
    assigned = [-1] * len(v)
    clusters: list[list[int]] = []
    for i in range(len(v)):
        if assigned[i] >= 0:
            continue
        cluster = [i]
        assigned[i] = len(clusters)
        for j in range(i + 1, len(v)):
            if assigned[j] < 0 and sims[i, j] >= threshold and (groups is None or groups[i] == groups[j]):
                cluster.append(j)
                assigned[j] = len(clusters)
        clusters.append(cluster)
    return clusters


async def _pattern(ctx: Ctx, job: DreamJob) -> dict[str, Any]:
    exps = await _window_experiences(ctx, job, DreamMode.PATTERN, lookback=True)
    proposals: list[str] = []
    stats: dict[str, int] = {"experiences": len(exps), "clusters": 0}
    for kind, min_size in (("failure", 2), ("success", 3)):
        group = [e for e in exps if e.outcome == kind]
        if len(group) < min_size:
            continue
        vecs = np.array(await ctx.container.embedder.embed([f"{e.task}\n{e.observation}" for e in group]))
        for cluster in _clusters(vecs, ctx.settings.dream_cluster_threshold):
            if len(cluster) < min_size:
                continue
            stats["clusters"] += 1
            members = [group[i] for i in cluster]
            out = await structured(
                ctx.container.llm,
                "pattern_summary",
                {"kind": kind, "experiences": [_exp_payload(e) for e in members]},
                SynthesisOut,
            )
            project = _common_project(members)
            m = await _propose_candidate(
                ctx,
                job,
                type=out.type,
                title=out.title,
                content=out.content,
                confidence=out.confidence,
                importance=max(e.importance for e in members),
                evidence=[
                    EvidenceInput(EvidenceSourceType.EXPERIENCE, str(e.id), "derived_from", 1.0, e.task)
                    for e in members
                ],
                scope=ScopeType.PROJECT if project else ScopeType.WORKSPACE,
                project_id=project,
                trust=min(e.source_trust for e in members),
                extra_meta={"pattern": {"kind": kind, "occurrences": len(members)}},
            )
            if m:
                proposals.append(str(m.id))
    await _save_mode_checkpoint(ctx, job, DreamMode.PATTERN, exps[-1].id if exps else None)
    stats["proposed"] = len(proposals)
    return {"proposals": proposals, "stats": stats}


async def _active_memories(ctx: Ctx, job: DreamJob, types: set[str] | None = None) -> list[Memory]:
    q = select(Memory).where(
        Memory.workspace_id == job.workspace_id,
        Memory.embedding.is_not(None),
        Memory.status.in_([MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value]),
        or_(Memory.valid_until.is_(None), Memory.valid_until > utcnow()),
    )
    if types:
        q = q.where(Memory.type.in_(types))
    q = q.order_by(Memory.created_at).limit(ctx.settings.dream_window_limit * 5)
    return list((await ctx.db.scalars(q)).all())


async def _evidence_counts(ctx: Ctx, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    rows = (
        await ctx.db.execute(
            select(MemoryEvidence.memory_id, func.count())
            .where(MemoryEvidence.memory_id.in_(ids))
            .group_by(MemoryEvidence.memory_id)
        )
    ).all()
    return {mid: int(n) for mid, n in rows}


def _compatible(members: list[Memory]) -> list[Memory]:
    """Drop members that contradict the first member (never merge contradictory knowledge)."""
    head = members[0]
    return [head] + [m for m in members[1:] if not contradiction.detect(head.content, m.content).contradicts]


async def _dedup(ctx: Ctx, job: DreamJob) -> dict[str, Any]:
    mems = await _active_memories(ctx, job)
    done: set[str] = set(job.checkpoint_json.get("done", []))
    groups = [(m.type, m.scope_type, m.scope_id, m.layer) for m in mems]
    clusters = [
        c
        for c in _clusters(
            np.array([_vec(m) for m in mems]) if mems else np.zeros((0, 1)), ctx.settings.dream_dedup_threshold, groups
        )
        if len(c) > 1
    ]
    counts = await _evidence_counts(ctx, [m.id for m in mems]) if mems else {}
    applied, proposals, superseded = [], [], 0
    for cluster in clusters:
        members = _compatible([mems[i] for i in cluster])
        if len(members) < 2:
            continue
        key = _hash(*sorted(str(m.id) for m in members))
        if key in done:
            continue
        canonical = max(
            members, key=lambda m: (counts.get(m.id, 0), m.utility_score, m.confidence, -m.created_at.timestamp())
        )
        others = [m for m in members if m.id != canonical.id]
        entry = {"canonical": str(canonical.id), "duplicates": [str(m.id) for m in others]}
        if not ctx.settings.dream_auto_apply:
            proposals.append(entry)
            continue
        canon = await memory_service.lock_memory(ctx, canonical.id)
        for o in others:
            dup = await memory_service.lock_memory(ctx, o.id)
            await memory_service.copy_evidence(ctx, dup, canon)
            await memory_service.add_evidence(
                ctx,
                canon,
                EvidenceInput(EvidenceSourceType.MEMORY, str(dup.id), "derived_from", 1.0, dup.content[:500]),
            )
            await memory_service.supersede(ctx, dup, canon, f"deduplicated by dream {job.id}")
            superseded += 1
        reinforced = round(min(0.98, canon.confidence + 0.03 * len(others)), 4)
        await memory_service.apply_changes(
            ctx,
            canon,
            {"confidence": reinforced},
            f"canonical for {len(others)} duplicate(s) (dream {job.id})",
            action="memory.dedup",
        )
        applied.append(entry)
        done.add(key)
        await _checkpoint(ctx, job, done=sorted(done))
    ratio = round(len(mems) / max(1, len(mems) - superseded), 4) if mems else 1.0
    metrics.DREAM_COMPRESSION_RATIO.labels(mode="deduplication").set(ratio)
    return {
        "applied": applied,
        "proposals": proposals,
        "stats": {
            "memories_scanned": len(mems),
            "clusters": len(applied) + len(proposals),
            "superseded": superseded,
            "compression_ratio": ratio,
        },
    }


def _merge_contents(members: list[dict[str, Any]], base: str) -> str:
    """Keep every distinct sentence from members (information-preserving consolidation)."""
    from app.domain.text import jaccard

    out = [s.strip() for s in base.split(". ") if s.strip()]
    for m in members:
        for sent in (s.strip() for s in m["content"].split(". ") if s.strip()):
            if all(jaccard(sent, o) < 0.7 for o in out):
                out.append(sent)
    text = ". ".join(s.rstrip(".") for s in out)
    return text if text.endswith(".") else text + "."


async def _compression(ctx: Ctx, job: DreamJob) -> dict[str, Any]:
    mems = await _active_memories(ctx, job)
    done: set[str] = set(job.checkpoint_json.get("done", []))
    groups = [(m.type, m.scope_type, m.scope_id, m.layer) for m in mems]
    clusters = [
        c
        for c in _clusters(
            np.array([_vec(m) for m in mems]) if mems else np.zeros((0, 1)),
            ctx.settings.dream_compression_threshold,
            groups,
        )
        if len(c) > 1
    ]
    applied, proposals, replaced = [], [], 0
    for cluster in clusters:
        members = _compatible([mems[i] for i in cluster])
        if len(members) < 2:
            continue
        key = _hash(*sorted(str(m.id) for m in members))
        if key in done:
            continue
        payload = [
            {"id": str(m.id), "type": m.type, "title": m.title, "content": m.content, "confidence": m.confidence}
            for m in members
        ]
        out = await structured(ctx.container.llm, "consolidation", {"memories": payload}, SynthesisOut)
        content = _merge_contents(payload, out.content)
        entry = {"members": [str(m.id) for m in members], "title": out.title}
        if not ctx.settings.dream_auto_apply:
            proposals.append(entry)
            continue
        first = members[0]
        refs = Refs((await ctx.db.get(Workspace, job.workspace_id)), first.project_id, first.agent_id, None)  # type: ignore[arg-type]
        if first.scope_type == ScopeType.SESSION.value:
            refs.session_id = first.scope_id
        consolidated = await memory_service.create_memory(
            ctx,
            refs=refs,
            type=MemoryType(first.type),
            scope_type=ScopeType(first.scope_type),
            title=out.title,
            content=content,
            status=MemoryStatus.CANDIDATE,
            confidence=min(out.confidence, max(m.confidence for m in members)),
            trust=min(m.trust_score for m in members),
            importance=max(m.importance for m in members),
            evidence=[
                EvidenceInput(EvidenceSourceType.MEMORY, str(m.id), "derived_from", 1.0, m.content[:500])
                for m in members
            ],
            reason=f"consolidated from {len(members)} memories by compression dream {job.id}",
            layer=first.layer,
            metadata={"dream": {"id": str(job.id), "mode": job.mode}, "consolidated_from": entry["members"]},
        )
        consolidated.utility_score = max(m.utility_score for m in members)
        for m in members:
            locked = await memory_service.lock_memory(ctx, m.id)
            await memory_service.copy_evidence(ctx, locked, consolidated)
            await memory_service.add_relation(ctx, consolidated, locked, RelationType.DERIVED_FROM)
        await memory_service.transition(ctx, consolidated, MemoryStatus.VALIDATED, "consolidation of active memories")
        await memory_service.transition(ctx, consolidated, MemoryStatus.ACTIVE, "consolidation of active memories")
        for m in members:
            locked = await memory_service.lock_memory(ctx, m.id)
            await memory_service.supersede(ctx, locked, consolidated, f"compressed by dream {job.id}")
            replaced += 1
        entry["consolidated"] = str(consolidated.id)
        applied.append(entry)
        done.add(key)
        await _checkpoint(ctx, job, done=sorted(done))
    ratio = round(replaced / max(1, len(applied)), 4) if applied else 1.0
    metrics.DREAM_COMPRESSION_RATIO.labels(mode="compression").set(ratio)
    return {
        "applied": applied,
        "proposals": proposals,
        "stats": {
            "memories_scanned": len(mems),
            "clusters": len(applied) + len(proposals),
            "superseded": replaced,
            "compression_ratio": ratio,
        },
    }


async def _contradiction(ctx: Ctx, job: DreamJob) -> dict[str, Any]:
    types = {t.value for t in MemoryType} - {t.value for t in OBSERVATIONAL_TYPES}
    mems = await _active_memories(ctx, job, types)
    opened: list[str] = []
    if len(mems) >= 2:
        v = np.array([_vec(m) for m in mems])
        v = v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)
        sims = v @ v.T
        existing_pairs = {
            frozenset((a, b))
            for a, b in (
                await ctx.db.execute(
                    select(Conflict.candidate_memory_id, Conflict.existing_memory_id).where(
                        Conflict.workspace_id == job.workspace_id
                    )
                )
            ).all()
        }
        for i in range(len(mems)):
            for j in range(i + 1, len(mems)):
                if sims[i, j] < ctx.settings.contradiction_similarity_threshold:
                    continue
                a, b = mems[i], mems[j]
                if frozenset((a.id, b.id)) in existing_pairs:
                    continue
                older, newer = (a, b) if a.created_at <= b.created_at else (b, a)
                judgment = await structured(
                    ctx.container.llm,
                    "contradiction_judgment",
                    {"a": older.content, "b": newer.content},
                    ContradictionOut,
                )
                if judgment.relation not in ("contradicts", "supersedes"):
                    continue
                sig = contradiction.detect(older.content, newer.content)
                conflict = Conflict(
                    organization_id=job.organization_id,
                    workspace_id=job.workspace_id,
                    candidate_memory_id=newer.id,
                    existing_memory_id=older.id,
                    conflict_type=sig.kind or "contradiction",
                    analysis_json={
                        "similarity": round(float(sims[i, j]), 4),
                        "judgment": judgment.model_dump(),
                        "found_by_dream": str(job.id),
                        "rule_signal": {"kind": sig.kind, "supersede_hint": sig.supersede_hint},
                    },
                )
                ctx.db.add(conflict)
                await ctx.db.flush()
                existing_pairs.add(frozenset((a.id, b.id)))
                locked = await memory_service.lock_memory(ctx, newer.id)
                if locked.status in (MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value):
                    await memory_service.transition(
                        ctx, locked, MemoryStatus.DISPUTED, f"contradiction found by dream {job.id}"
                    )
                await memory_service.add_relation(
                    ctx, locked, older, RelationType.CONTRADICTS, {"conflict_id": str(conflict.id)}
                )
                metrics.CONFLICTS_OPENED.inc()
                opened.append(str(conflict.id))
    await ctx.commit()
    resolved: list[dict[str, str]] = []
    open_conflicts = (
        await ctx.db.scalars(
            select(Conflict).where(Conflict.workspace_id == job.workspace_id, Conflict.status == "open")
        )
    ).all()
    for c in open_conflicts:
        decision, why = await conflict_service.auto_resolution(ctx, c)
        if decision and ctx.settings.dream_auto_apply:
            await conflict_service.resolve(ctx, c.id, decision, f"auto: {why}", auto=True)
            resolved.append({"conflict": str(c.id), "resolution": decision.value, "why": why})
    return {
        "applied": resolved,
        "opened": opened,
        "stats": {
            "memories_scanned": len(mems),
            "conflicts_opened": len(opened),
            "auto_resolved": len(resolved),
            "open_remaining": len(open_conflicts) - len(resolved),
        },
    }


async def _generalization(ctx: Ctx, job: DreamJob) -> dict[str, Any]:
    kinds = {
        MemoryType.LESSON.value,
        MemoryType.PROCEDURE.value,
        MemoryType.RULE.value,
        MemoryType.WARNING.value,
        MemoryType.PATTERN.value,
    }
    mems = [m for m in await _active_memories(ctx, job, kinds) if m.scope_type in ("project", "agent")]
    proposals: list[str] = []
    groups = [m.type for m in mems]
    clusters = _clusters(
        np.array([_vec(m) for m in mems]) if mems else np.zeros((0, 1)), ctx.settings.dream_cluster_threshold, groups
    )
    for cluster in clusters:
        members = _compatible([mems[i] for i in cluster])
        scopes = {(m.scope_type, m.scope_id) for m in members}
        if len(members) < 2 or len(scopes) < 2:
            continue
        key = _hash("generalize", *sorted(str(m.id) for m in members))
        exists = await ctx.db.scalar(
            select(Memory.id).where(
                Memory.workspace_id == job.workspace_id, Memory.metadata_json["generalization_key"].astext == key
            )
        )
        if exists:
            continue
        out = await structured(
            ctx.container.llm,
            "generalization",
            {
                "memories": [
                    {
                        "id": str(m.id),
                        "type": m.type,
                        "title": m.title,
                        "content": m.content,
                        "confidence": m.confidence,
                    }
                    for m in members
                ]
            },
            SynthesisOut,
        )
        m_new = await _propose_candidate(
            ctx,
            job,
            type=out.type,
            title=out.title,
            content=out.content,
            confidence=min(out.confidence, min(m.confidence for m in members)),
            importance=max(m.importance for m in members),
            evidence=[
                EvidenceInput(EvidenceSourceType.MEMORY, str(m.id), "derived_from", 1.0, m.content[:500])
                for m in members
            ],
            scope=ScopeType.WORKSPACE,
            project_id=None,
            trust=min(m.trust_score for m in members),
            review_state=ReviewState.PENDING,
            extra_meta={"generalization_key": key, "generalized_from": [str(m.id) for m in members]},
        )
        if m_new:
            for m in members:
                await memory_service.add_relation(ctx, m_new, m, RelationType.GENERALIZES)
            proposals.append(str(m_new.id))
    return {"proposals": proposals, "stats": {"memories_scanned": len(mems), "proposed": len(proposals)}}


_RUNNERS = {
    DreamMode.REFLECTION: _reflection,
    DreamMode.DEDUPLICATION: _dedup,
    DreamMode.PATTERN: _pattern,
    DreamMode.CONTRADICTION: _contradiction,
    DreamMode.GENERALIZATION: _generalization,
    DreamMode.COMPRESSION: _compression,
}


# ============================================================================ scheduling
async def schedule_workspace(ctx: Ctx, ws: Workspace) -> list[str]:
    """Decide whether a workspace needs a dream cycle (interval, experience count, memory growth)."""
    s = ctx.settings
    st = await ctx.db.scalar(
        select(SchedulerState)
        .where(SchedulerState.workspace_id == ws.id, SchedulerState.task == "dream_cycle")
        .with_for_update()
    )
    now = utcnow()
    if st is None:
        st = SchedulerState(
            organization_id=ws.organization_id,
            workspace_id=ws.id,
            task="dream_cycle",
            counters_json={},
            last_run_at=None,
        )
        ctx.db.add(st)
        await ctx.db.flush()
    since = st.last_run_at
    new_exps = int(
        await ctx.db.scalar(
            select(func.count())
            .select_from(Experience)
            .where(Experience.workspace_id == ws.id, *([Experience.created_at > since] if since else []))
        )
        or 0
    )
    active = int(
        await ctx.db.scalar(
            select(func.count()).select_from(Memory).where(Memory.workspace_id == ws.id, Memory.status == "active")
        )
        or 0
    )
    last_active = int(st.counters_json.get("active_memories", 0))
    trigger = None
    if new_exps >= s.dream_experience_threshold:
        trigger = "event_count"
    elif active - last_active >= s.dream_memory_growth_threshold:
        trigger = "memory_growth"
    elif new_exps > 0 and (since is None or (now - since).total_seconds() >= s.dream_interval_minutes * 60):
        trigger = "schedule"
    if trigger is None:
        return []
    created = []
    for mode in (
        DreamMode.REFLECTION,
        DreamMode.PATTERN,
        DreamMode.DEDUPLICATION,
        DreamMode.CONTRADICTION,
        DreamMode.COMPRESSION,
        DreamMode.GENERALIZATION,
    ):
        job, is_new = await request_dream(ctx, ws.id, mode, trigger_type=trigger)
        if is_new:
            created.append(str(job.id))
    st.last_run_at = now
    st.counters_json = {**st.counters_json, "active_memories": active, "last_trigger": trigger}
    st.updated_at = now
    return created


def dream_stats(jobs: list[DreamJob]) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for j in jobs:
        out[j.status] += 1
    return dict(out)
