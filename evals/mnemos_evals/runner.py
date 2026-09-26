"""Learning eval: Run A -> governed learning -> independent Run B.

Usage: mnemos-eval --url http://localhost:8000 --secret $API_BOOTSTRAP_SECRET [--output artifacts/eval-report.json]
Requires a running Mnemos API **and worker** (the learning pipeline is asynchronous).
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from mnemos_evals.agent import RunResult, run_task
from mnemos_evals.scenarios import FALSE_MEMORY, FAMILIES, STALE_MEMORY
from mnemos_sdk import MnemosClient

CONTEXT_BUDGET = 600
MAX_ITEMS = 3


def _p(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return round(s[min(len(s) - 1, math.ceil(q * len(s)) - 1)], 2)


def _ctx(
    c: MnemosClient, ws: str, project_id: str, agent_id: str, session: str, query: str, latencies: list[float]
) -> dict[str, Any]:
    t0 = time.perf_counter()
    res = c.context(
        ws,
        query,
        token_budget=CONTEXT_BUDGET,
        project_id=project_id,
        agent_id=agent_id,
        session_id=session,
        max_items=MAX_ITEMS,
    )
    latencies.append((time.perf_counter() - t0) * 1000)
    return res


def run_eval(url: str, secret: str, output: str | None = None, timeout: float = 60.0) -> dict[str, Any]:
    started = time.time()
    run_id = uuid.uuid4().hex[:8]
    with MnemosClient(url) as anon:
        boot = anon.bootstrap(secret, f"eval-org-{run_id}", "eval")
    ws = boot["workspace_id"]
    c = MnemosClient(url, boot["api_key"])
    projects = {
        p: c.request("POST", f"/v1/workspaces/{ws}/projects", json={"name": p})["id"]
        for p in sorted({f.project for f in FAMILIES})
    }
    agent_a = c.request("POST", f"/v1/workspaces/{ws}/agents", json={"name": "agent-a"})["id"]
    agent_b = c.request("POST", f"/v1/workspaces/{ws}/agents", json={"name": "agent-b"})["id"]

    # Seed known-false and stale knowledge that must never reach Run B.
    false_mem = c.request(
        "POST",
        "/v1/memories",
        json={
            "workspace_id": ws,
            "project_id": projects["platform"],
            "scope_type": "project",
            "type": "procedure",
            "title": FALSE_MEMORY[1],
            "content": FALSE_MEMORY[0],
            "status": "active",
            "confidence": 0.6,
        },
        headers={"Idempotency-Key": f"false-{run_id}"},
    )
    for i in range(2):
        c.feedback(false_mem["id"], "incorrect", note="caused failed deploy", idempotency_key=f"fm-{run_id}-{i}")
    stale_mem = c.request(
        "POST",
        "/v1/memories",
        json={
            "workspace_id": ws,
            "project_id": projects["platform"],
            "scope_type": "project",
            "type": "procedure",
            "title": STALE_MEMORY[1],
            "content": STALE_MEMORY[0],
            "status": "active",
            "confidence": 0.7,
        },
        headers={"Idempotency-Key": f"stale-{run_id}"},
    )
    c.update_memory(stale_mem["id"], stale_mem["version"], status="superseded", reason="migrated to pnpm")
    bad_ids = {false_mem["id"], stale_mem["id"]}

    ctx_lat: list[float] = []
    learn_lat: list[float] = []
    families: list[dict[str, Any]] = []
    for fam in FAMILIES:
        pid = projects[fam.project]
        # ---- Run A: fresh agent/session, no prior knowledge
        sess_a = str(uuid.uuid4())
        ctx_a = _ctx(c, ws, pid, agent_a, sess_a, fam.task_a, ctx_lat)
        run_a = run_task(fam, fam.task_a, ctx_a["context"])
        c.events(
            ws,
            [
                {"type": "task", "payload": {"task": fam.task_a}},
                {"type": "error", "payload": {"message": fam.error}}
                if run_a.errors
                else {"type": "tool", "payload": {"note": "no error"}},
                {"type": "tool", "payload": {"tool_calls": run_a.tool_calls}},
            ],
            agent_id=agent_a,
            session_id=sess_a,
            project_id=pid,
        )
        t0 = time.perf_counter()
        exp = c.experience(
            ws,
            fam.task_a,
            "success" if run_a.success else "failure",
            observation=fam.error if run_a.errors else "No error encountered.",
            action=fam.fix_action,
            result=fam.success_result,
            project_id=pid,
            agent_id=agent_a,
            session_id=sess_a,
            task_id=f"{fam.key}-a",
            importance=0.8,
            confidence=0.85,
        )
        learned = c.wait_for_learning(exp["experience"]["id"], timeout=timeout)
        learn_lat.append((time.perf_counter() - t0) * 1000)
        mems = learned["learning"]["memories"]
        active = [m for m in mems if m["status"] == "active"]

        # ---- Run B: different agent + session, analogous task, retrieves context BEFORE acting
        sess_b = str(uuid.uuid4())
        ctx_b = _ctx(c, ws, pid, agent_b, sess_b, fam.task_b, ctx_lat)
        run_b = run_task(fam, fam.task_b, ctx_b["context"])
        selected = [m["id"] for m in ctx_b["memories"]]
        learned_ids = {m["id"] for m in active}
        relevant_selected = [i for i in selected if i in learned_ids]
        for mid in relevant_selected:
            c.feedback(mid, "helpful" if run_b.used_memory else "irrelevant", note=f"eval {run_id} run B")
        # ---- Control: same analogous task WITHOUT memory (baseline agent)
        control = run_task(fam, fam.task_b, "")
        families.append(
            {
                "family": fam.key,
                "run_a": _res(run_a),
                "run_b": _res(run_b),
                "control_b_without_memory": _res(control),
                "learned_memories": [
                    {"id": m["id"], "status": m["status"], "type": m["type"], "title": m["title"]} for m in mems
                ],
                "run_b_context": {
                    "selected": selected,
                    "token_estimate": ctx_b["token_estimate"],
                    "trace_id": ctx_b["retrieval_trace_id"],
                },
                "relevant_recalled": bool(relevant_selected),
                "precision": round(len(relevant_selected) / len(selected), 3) if selected else 0.0,
                "false_memory_served": bool(set(selected) & {false_mem["id"]}),
                "stale_memory_served": bool(set(selected) & {stale_mem["id"]}),
            }
        )

    n = len(families)
    rb = [f["run_b"] for f in families]
    cb = [f["control_b_without_memory"] for f in families]
    summary: dict[str, Any] = {
        "families": n,
        "measured": {
            "run_b_task_success_rate": sum(r["success"] for r in rb) / n,
            "run_b_repeated_error_rate": sum(r["repeated_error"] for r in rb) / n,
            "control_repeated_error_rate": sum(r["repeated_error"] for r in cb) / n,
            "relevant_memory_recall": sum(f["relevant_recalled"] for f in families) / n,
            "mean_precision_at_k": round(statistics.mean(f["precision"] for f in families), 3),
            "false_memory_rate": sum(f["false_memory_served"] for f in families) / n,
            "stale_memory_use_rate": sum(f["stale_memory_served"] for f in families) / n,
            "run_b_tool_calls_total": sum(r["tool_calls"] for r in rb),
            "control_tool_calls_total": sum(r["tool_calls"] for r in cb),
            "context_latency_ms_p50": _p(ctx_lat, 0.5),
            "context_latency_ms_p95": _p(ctx_lat, 0.95),
            "learning_latency_ms_p50": _p(learn_lat, 0.5),
            "learning_latency_ms_p95": _p(learn_lat, 0.95),
            "memories_learned_active": sum(
                1 for f in families for m in f["learned_memories"] if m["status"] == "active"
            ),
        },
        "estimated": {
            "note": "token counts are chars/4 estimates of the simulated agent transcript (no real LLM calls); "
            "they are NOT measured token or cost savings",
            "run_b_tokens_total_est": sum(r["est_tokens"] for r in rb),
            "control_tokens_total_est": sum(r["est_tokens"] for r in cb),
        },
    }
    m = summary["measured"]
    summary["measured"]["tool_call_reduction"] = round(
        1 - m["run_b_tool_calls_total"] / max(1, m["control_tool_calls_total"]), 3
    )
    summary["estimated"]["token_change_ratio_est"] = round(
        summary["estimated"]["run_b_tokens_total_est"] / max(1, summary["estimated"]["control_tokens_total_est"]), 3
    )
    summary["passed"] = (
        m["run_b_task_success_rate"] == 1.0
        and m["run_b_repeated_error_rate"] == 0.0
        and m["relevant_memory_recall"] == 1.0
        and m["false_memory_rate"] == 0.0
        and m["stale_memory_use_rate"] == 0.0
        and m["control_repeated_error_rate"] == 1.0
    )
    report = {
        "name": "learning-transfer-eval",
        "run_id": run_id,
        "api_url": url,
        "workspace_id": ws,
        "duration_s": round(time.time() - started, 2),
        "summary": summary,
        "families": families,
        "bad_memory_ids": sorted(bad_ids),
    }
    c.request(
        "POST",
        "/v1/evals/runs",
        json={
            "workspace_id": ws,
            "name": f"learning-transfer-{run_id}",
            "summary": summary,
            "result": {"families": families},
        },
    )
    c.close()
    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(json.dumps(report, indent=2))
        Path(output).with_suffix(".md").write_text(render_markdown(report))
    return report


def _res(r: RunResult) -> dict[str, Any]:
    return {
        "success": r.success,
        "used_memory": r.used_memory,
        "repeated_error": r.repeated_error,
        "errors": r.errors,
        "tool_calls": r.tool_calls,
        "est_tokens": r.est_tokens,
    }


def render_markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    m, e = s["measured"], s["estimated"]
    lines = [
        f"# Learning transfer eval ({report['run_id']})",
        "",
        f"API: `{report['api_url']}` - duration {report['duration_s']}s - **{'PASS' if s['passed'] else 'FAIL'}**",
        "",
        "## Measured",
        "",
        "| metric | value |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in m.items()],
        "",
        "## Estimated (not measured)",
        "",
        f"_{e['note']}_",
        "",
        "| metric | value |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in e.items() if k != "note"],
        "",
        "## Per family",
        "",
        "| family | run A errors/tool calls | run B errors/tool calls | control errors/tool calls | recalled | "
        "precision |",
        "|---|---|---|---|---|---|",
    ]
    for f in report["families"]:
        a, b, c = f["run_a"], f["run_b"], f["control_b_without_memory"]
        lines.append(
            f"| {f['family']} | {a['errors']}/{a['tool_calls']} | {b['errors']}/{b['tool_calls']} | "
            f"{c['errors']}/{c['tool_calls']} | {f['relevant_recalled']} | {f['precision']} |"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--secret", required=True)
    ap.add_argument("--output", default="artifacts/eval-report.json")
    ap.add_argument("--timeout", type=float, default=60.0)
    args = ap.parse_args()
    report = run_eval(args.url, args.secret, args.output, args.timeout)
    print(json.dumps(report["summary"], indent=2))
    sys.exit(0 if report["summary"]["passed"] else 1)


if __name__ == "__main__":
    main()
