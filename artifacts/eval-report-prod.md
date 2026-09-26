# Learning transfer eval (31a9eeb8)

API: `http://localhost/api` - duration 2.86s - **PASS**

## Measured

| metric | value |
|---|---|
| run_b_task_success_rate | 1.0 |
| run_b_repeated_error_rate | 0.0 |
| control_repeated_error_rate | 1.0 |
| relevant_memory_recall | 1.0 |
| mean_precision_at_k | 1.0 |
| false_memory_rate | 0.0 |
| stale_memory_use_rate | 0.0 |
| run_b_tool_calls_total | 5 |
| control_tool_calls_total | 22 |
| context_latency_ms_p50 | 25.77 |
| context_latency_ms_p95 | 38.35 |
| learning_latency_ms_p50 | 380.69 |
| learning_latency_ms_p95 | 388.9 |
| memories_learned_active | 5 |
| tool_call_reduction | 0.773 |

## Estimated (not measured)

_token counts are chars/4 estimates of the simulated agent transcript (no real LLM calls); they are NOT measured token or cost savings_

| metric | value |
|---|---|
| run_b_tokens_total_est | 1120 |
| control_tokens_total_est | 563 |
| token_change_ratio_est | 1.989 |

## Per family

| family | run A errors/tool calls | run B errors/tool calls | control errors/tool calls | recalled | precision |
|---|---|---|---|---|---|
| deploy-migrations | 1/5 | 0/1 | 1/5 | True | 1.0 |
| web-install | 1/4 | 0/1 | 1/4 | True | 1.0 |
| docker-build | 1/5 | 0/1 | 1/5 | True | 1.0 |
| partner-api-auth | 1/4 | 0/1 | 1/4 | True | 1.0 |
| bulk-export | 1/4 | 0/1 | 1/4 | True | 1.0 |
