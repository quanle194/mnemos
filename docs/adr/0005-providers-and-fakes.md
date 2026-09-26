# ADR 0005 - Provider abstraction and deterministic fake providers

Status: accepted

## Decision
- `LLMProvider.generate_json(task, system, payload, schema)` returns a dict validated by a Pydantic schema;
  invalid output is retried (bounded) and then fails the job without partial writes.
- `EmbeddingProvider.embed(texts) -> list[list[float]]` with a declared dimension checked at startup.
- Implementations: `fake` (deterministic), `openai` (any OpenAI-compatible `/v1/chat/completions` and
  `/v1/embeddings`, e.g. OpenAI, vLLM, LM Studio, LiteLLM), `ollama` (native `/api/chat`, `/api/embed`).
- The fake LLM is a deterministic rule-based implementation of each task (`memory_extraction`,
  `episode_summary`, `reflection`, `generalization`, `consolidation`, `contradiction_judgment`). It reads the
  JSON payload, not prompt prose, so behaviour is stable across prompt edits.
- The fake embedding uses feature hashing of normalised word unigrams + bigrams + character trigrams into
  `EMBEDDING_DIMENSIONS` with L2 normalisation, giving meaningful lexical-semantic cosine similarity.
- Providers are constructed from settings and injected; no module-level global provider state.
- Real-provider tests are opt-in (`pytest -m real_provider`).
