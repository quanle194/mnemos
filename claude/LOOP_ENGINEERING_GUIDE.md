# Loop Engineering Guide

This guide defines the autonomous control loop. It is a completion protocol, not permission to bypass security, fabricate credentials, or conceal failures.

## Prime directive
Continue working until the Definition of Done is objectively satisfied or a genuine external blocker exists that cannot be solved inside the repository/environment. Never stop merely because one implementation pass completed. Never wait for confirmation for ordinary reversible engineering decisions.

## Persistent loop
Repeat:

1. ORIENT
   - Read `README.md`, all `docs/`, `CLAUDE.md`, current plans/reports, git diff/status, failing logs/tests.
   - Determine current state from evidence, not assumptions.

2. GAP ANALYSIS
   - Compare repository against every requirement and acceptance gate.
   - Maintain `docs/IMPLEMENTATION_STATUS.md` with requirement -> state -> evidence -> next action.
   - Search for TODO/FIXME/stubs/skips/placeholders and decide whether each violates required scope.

3. PLAN
   - Select the smallest coherent batch that reduces the highest-risk gaps.
   - Resolve ambiguity with: existing spec -> code conventions -> safest reversible default -> ADR. Ask no question when this rule yields a sound choice.

4. IMPLEMENT
   - Implement production code, migrations, tests, docs and operational changes together.
   - Prefer vertical slices over disconnected scaffolding.
   - Do not mock the feature itself in E2E; mocks/fakes are allowed at external LLM/provider boundaries for deterministic tests.

5. VERIFY LOCALLY
   - Run formatter/linter/typecheck and focused tests.
   - Fix root causes. Do not disable tests, weaken assertions or hide errors to obtain green status.

6. INTEGRATE
   - Run broader integration/API/worker/frontend suites.
   - Verify migrations and idempotency/concurrency paths.

7. E2E
   - Start the real local stack from clean state.
   - Execute mandatory E2E scenarios and capture evidence.
   - Test failure/restart paths, not only happy path.

8. INFRASTRUCTURE
   - Build production images/Compose.
   - Exercise Ubuntu/VPS-equivalent deployment scripts where environment permits.
   - Test backup + restore and production smoke flow.

9. REVIEW
   - Self-review git diff for security, tenancy leaks, error handling, race conditions, observability, dead code and docs drift.
   - Run dependency/security checks available in the environment.

10. SCORE AGAINST DONE
   - For every acceptance criterion mark PASS only with a command/test/artifact proving it.
   - If any required item is FAIL/UNKNOWN, create next batch and loop to step 1.

11. CLOSE ONLY WHEN DONE
   - Generate `artifacts/implementation-report.md`, `artifacts/test-report.md`, `artifacts/deployment-report.md`.
   - Reports contain commands, results, known limitations and external operator inputs.
   - A genuine blocker must include exact blocker, attempts made, evidence, and the maximum completed work around it. Do not use a missing optional credential/domain as a reason to stop coding/testing with local/fake providers.

## Anti-stall rules
- Do not ask preference questions about libraries when the spec permits a reasonable choice; create an ADR.
- Do not stop after writing a plan.
- Do not stop after scaffolding.
- Do not leave required TODOs for a later agent.
- Do not claim a command passed unless it was run successfully.
- Do not silently skip slow E2E/deployment tests.
- When a test fails, diagnose -> fix -> rerun until pass.
- When context becomes large, write durable state to `docs/IMPLEMENTATION_STATUS.md` and reports before continuing; reload these files on the next context.
- Commit checkpoints if repository policy permits, but a commit is never a completion signal.

## Decision policy
Priority: correctness > security/data isolation > durability > observability > maintainability > performance > convenience. Prefer simple production-capable architecture over speculative distributed complexity.

## Required autonomous artifacts
Create and continuously update:
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/adr/*.md`
- `artifacts/implementation-report.md`
- `artifacts/test-report.md`
- `artifacts/deployment-report.md`

## Exit condition
Exit only when all required criteria in `docs/06-testing-evals.md`, `docs/07-infrastructure-deployment.md`, and `docs/08-implementation-roadmap.md` are PASS with evidence, or when a truly external blocker makes further progress impossible. In the blocker case, complete every independent task first.
