import { describe, expect, it } from "vitest";

import { camelToSnake, camelizeResponse, snakeToCamel, snakeizeRequest } from "../src/index.js";

describe("key case conversion", () => {
  it("converts single keys", () => {
    expect(snakeToCamel("retrieval_trace_id")).toBe("retrievalTraceId");
    expect(snakeToCamel("retrieval_24h")).toBe("retrieval24h");
    expect(snakeToCamel("id")).toBe("id");
    expect(camelToSnake("tokenBudget")).toBe("token_budget");
    expect(camelToSnake("workspaceId")).toBe("workspace_id");
    expect(camelToSnake("q")).toBe("q");
  });

  it("camelizes nested structures but keeps data maps verbatim", () => {
    const out = camelizeResponse({
      items: [{ memory: { trust_score: 1, metadata_json: { user_key: { deep_key: 1 } } }, scores: { trust_score: 1 } }],
      next_cursor: null,
      memories_by_status: { candidate: 1 },
    });
    expect(out).toEqual({
      items: [{ memory: { trustScore: 1, metadataJson: { user_key: { deep_key: 1 } } }, scores: { trust_score: 1 } }],
      nextCursor: null,
      memoriesByStatus: { candidate: 1 },
    });
  });

  it("converts arrays under data-map keys (e.g. evidence lists)", () => {
    expect(camelizeResponse({ evidence: [{ source_type: "event" }] })).toEqual({ evidence: [{ sourceType: "event" }] });
  });

  it("snakeizes requests, drops undefined, keeps null and serializes dates", () => {
    expect(
      snakeizeRequest({
        workspaceId: "w",
        projectId: undefined,
        validUntil: null,
        validFrom: new Date("2026-01-01T00:00:00Z"),
        evidence: [{ sourceType: "event", sourceId: "e" }],
        metadata: { camelKey: { innerKey: 1 } },
      }),
    ).toEqual({
      workspace_id: "w",
      valid_until: null,
      valid_from: "2026-01-01T00:00:00.000Z",
      evidence: [{ source_type: "event", source_id: "e" }],
      metadata: { camelKey: { innerKey: 1 } },
    });
  });
});
