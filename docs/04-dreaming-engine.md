# Learning and Dreaming Engine

## Extraction
Consume unprocessed experiences/episodes. Structured LLM extraction decides whether durable future-useful knowledge exists and emits zero or more candidate memories with type, content, confidence, importance and evidence IDs. Speculation must remain low-confidence candidate knowledge.

## Validation pipeline
For each candidate:
1. Normalize and embed.
2. Retrieve semantically/lexically related active memories in the same authorized scope.
3. Detect duplicate/support/contradiction/superseding relationship.
4. Check evidence strength/source trust/security policy.
5. Decide: promote, merge, reject, dispute, require_review.
6. Apply transactionally and append audit/version/evidence/relation records.

## Poisoning controls
Treat retrieved/external text as data, never as system instructions. Classify candidate kind and source. Untrusted external observations cannot become policy/instruction automatically. Strip/flag instruction-like prompt-injection content. High-impact rules require stronger evidence or review policy. Preserve original evidence for audit.

## Dreaming modes
- reflection: summarize durable lessons from a window.
- deduplication: cluster near-duplicates and propose canonical memories.
- pattern: find repeated failures/successes.
- contradiction: identify unresolved conflicting knowledge.
- generalization: propose broader rules from repeated evidence, with calibrated confidence.
- compression: replace redundant active memories with consolidated canonical knowledge while superseding originals.

## Scheduling
Support cron-like periodic runs, thresholds (N new experiences), growth thresholds and manual jobs. Dreaming is asynchronous. Use bounded windows and checkpoint progress so jobs can resume.

## Guardrails
No dream job may silently delete evidence/history. Consolidation creates versions/relations. LLM output is schema-validated. Re-running same input window must be idempotent or detect prior processing.

## Forgetting/lifecycle
Compute configurable decay/utility signals from age, retrieval usage, helpfulness, correctness/outdated feedback and importance. Transition active -> cold/archived only under policy; never remove evidence chain. Superseded and expired knowledge is not normal retrieval material.
