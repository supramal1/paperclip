import type { MaCustomToolSpec } from "./client.js";

// Agent-facing Cornerstone tool names. Order matters only for presentation.
// Handler implementation and write/blocked tool policy live in
// server/src/services/cornerstone-tools.ts; this file is the MA wire spec only.
export const CORNERSTONE_TOOL_NAMES = [
  "get_context",
  "search",
  "list_facts",
  "recall",
  "add_fact",
  "save_conversation",
  "steward_inspect",
  "steward_advise",
  "steward_preview",
  "steward_apply",
  "steward_status",
] as const;

export type CornerstoneToolName = (typeof CORNERSTONE_TOOL_NAMES)[number];

export function isCornerstoneToolName(name: string): name is CornerstoneToolName {
  return (CORNERSTONE_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Specs.
//
// One MaCustomToolSpec per agent-facing Cornerstone tool. Input schemas mirror
// the handler's input guards in server/src/services/cornerstone-tools.ts so
// the model sees the same required/optional fields the handler enforces.
//
// Write tools (add_fact, save_conversation, steward_preview, steward_apply)
// still accept `namespace` in their schema for shape parity with read tools,
// but the handler forces namespace to `ai-ops` regardless — per-agent
// attribution is carried via key prefix conventions, not namespace.
// ---------------------------------------------------------------------------

const STEWARD_INSPECT_OPERATIONS = [
  "duplicates",
  "contradictions",
  "stale",
  "expired",
  "orphans",
  "key-taxonomy",
  "missing-dates",
  "stale-embeddings",
  "cross-workspace-duplicates",
  "retrieval-interference",
  "composite-health",
  "fact-quality",
] as const;

const STEWARD_ADVISE_OPERATIONS = [
  "merge",
  "consolidate",
  "stale-review",
  "key-taxonomy",
  "contradictions",
] as const;

const STEWARD_PREVIEW_OPERATIONS = [
  "merge-duplicates",
  "merge-notes",
  "archive-stale",
  "delete-by-filter",
  "consolidate-facts",
  "reembed-stale",
  "rename-keys",
] as const;

function getContextSpec(): MaCustomToolSpec {
  return {
    name: "get_context",
    description:
      "Retrieve structured context from Cornerstone memory for a natural-language query. Returns a composed context bundle (facts, notes, summaries). Use this before making architecture or sprint decisions to ground your reasoning in prior work.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language question, e.g. 'recent Paperclip delegation decisions' or 'Donald's audit findings'.",
        },
        namespace: {
          type: "string",
          description:
            "Optional workspace to scope retrieval. Omit to search the default (ai-ops).",
        },
        detail_level: {
          type: "string",
          description:
            "How much detail to return. One of: minimal, standard, comprehensive. Default: standard.",
        },
        max_tokens: {
          type: "integer",
          description: "Soft upper bound on returned token count. Default 2000.",
        },
      },
      required: ["query"],
    },
  };
}

function searchSpec(): MaCustomToolSpec {
  return {
    name: "search",
    description:
      "Lighter-weight lookup than get_context — quick existence check or surface-level answer. Returns a shorter bundle. Use when you need to check whether Cornerstone has anything on a topic before committing to deeper retrieval.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query.",
        },
        namespace: {
          type: "string",
          description: "Optional workspace scope.",
        },
        detail_level: {
          type: "string",
          description: "minimal | standard | comprehensive. Default: minimal.",
        },
        max_tokens: {
          type: "integer",
          description: "Soft upper bound on returned token count. Default 600.",
        },
      },
      required: ["query"],
    },
  };
}

function listFactsSpec(): MaCustomToolSpec {
  return {
    name: "list_facts",
    description:
      "List facts by key prefix or category. Returns raw fact rows (key, value, confidence, updated_at). Use for audits, duplicate hunts, or inspecting a known key family (e.g. key_prefix='co_paperclip_').",
    input_schema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description: "Optional workspace scope.",
        },
        key_prefix: {
          type: "string",
          description: "Filter facts whose key starts with this prefix.",
        },
        category: {
          type: "string",
          description: "Filter facts by category (e.g. 'architecture', 'sprint', 'config').",
        },
        limit: {
          type: "integer",
          description: "Maximum number of facts to return (1-500, default server-side).",
        },
      },
      required: [],
    },
  };
}

function recallSpec(): MaCustomToolSpec {
  return {
    name: "recall",
    description:
      "Higher-detail recall for a specific query. Same backend as get_context but with detail_level=comprehensive and larger token budget by default. Use when you need the fullest available context on a narrow topic.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query.",
        },
        namespace: {
          type: "string",
          description: "Optional workspace scope.",
        },
        detail_level: {
          type: "string",
          description: "minimal | standard | comprehensive. Default: comprehensive.",
        },
        max_tokens: {
          type: "integer",
          description: "Soft upper bound on returned token count. Default 4000.",
        },
      },
      required: ["query"],
    },
  };
}

function addFactSpec(): MaCustomToolSpec {
  return {
    name: "add_fact",
    description:
      "Record a discrete, stable, referenceable fact to Cornerstone (always written to the ai-ops workspace). Facts must be atomic (one topic), objectively true or user-confirmed, and under ~200 tokens. Use descriptive key conventions (e.g. 'co_paperclip_<topic>').",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Specific, searchable key. Avoid vague names like 'update' or 'note'.",
        },
        value: {
          type: "string",
          description: "Fact body. Include dates where possible ('Deployed 2026-04-20').",
        },
        category: {
          type: "string",
          description:
            "Optional category (e.g. 'architecture', 'sprint', 'deployment'). Default: 'general'.",
        },
        confidence: {
          type: "number",
          description: "Confidence 0.0-1.0. Default 0.9.",
        },
      },
      required: ["key", "value"],
    },
  };
}

function saveConversationSpec(): MaCustomToolSpec {
  return {
    name: "save_conversation",
    description:
      "Persist a business-relevant exchange (decision, debugging session, planning) to Cornerstone (always ai-ops). Captures the WHY behind decisions. Do not save personal/off-topic chatter. Pass descriptive `topic`, not 'conversation about stuff'.",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Short descriptive topic for the exchange.",
        },
        messages: {
          type: "array",
          description:
            "Ordered array of message objects with `role` ('user'|'assistant') and `content`.",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
        },
        source: {
          type: "string",
          description: "Optional source tag (e.g. 'paperclip-workforce:ada').",
        },
      },
      required: ["topic", "messages"],
    },
  };
}

function stewardInspectSpec(): MaCustomToolSpec {
  return {
    name: "steward_inspect",
    description:
      "Run a read-only Cornerstone steward inspection. Surfaces memory-health issues (duplicates, contradictions, stale rows, key-taxonomy drift, etc.). Non-destructive — returns a report the agent can cite in its findings.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: `Which inspection to run. One of: ${STEWARD_INSPECT_OPERATIONS.join(", ")}.`,
        },
        namespace: {
          type: "string",
          description: "Optional workspace scope for the inspection.",
        },
      },
      required: ["operation"],
      additionalProperties: true,
    },
  };
}

function stewardAdviseSpec(): MaCustomToolSpec {
  return {
    name: "steward_advise",
    description:
      "Request a steward recommendation (merge plan, consolidation plan, taxonomy suggestion). Read-only: returns suggestions an operator can review before running a mutating preview/apply.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: `Which advice operation. One of: ${STEWARD_ADVISE_OPERATIONS.join(", ")}.`,
        },
        namespace: {
          type: "string",
          description: "Optional workspace scope.",
        },
      },
      required: ["operation"],
      additionalProperties: true,
    },
  };
}

function stewardPreviewSpec(): MaCustomToolSpec {
  return {
    name: "steward_preview",
    description:
      "Dry-run a mutating steward operation against the ai-ops workspace. Returns the exact changes that would be applied by steward_apply, without touching memory. Safe to call; namespace is always forced to ai-ops.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: `Which mutation to preview. One of: ${STEWARD_PREVIEW_OPERATIONS.join(", ")}.`,
        },
      },
      required: ["operation"],
      additionalProperties: true,
    },
  };
}

function stewardApplySpec(): MaCustomToolSpec {
  return {
    name: "steward_apply",
    description:
      "Apply a mutating steward operation. Currently BLOCKED pending the approval-queue UI — every call returns pending_approval with errorCode='approval_queue_not_available'. Use steward_preview instead and surface the audit as a recommendation.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            "Which mutation to apply. Blocked at the handler level — prefer steward_preview.",
        },
      },
      required: ["operation"],
      additionalProperties: true,
    },
  };
}

function stewardStatusSpec(): MaCustomToolSpec {
  return {
    name: "steward_status",
    description:
      "Poll the status of a previously-queued steward maintenance job by its job_id. Returns current state (queued/running/done/failed) and any output.",
    input_schema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Maintenance job id returned by a prior steward operation.",
        },
      },
      required: ["job_id"],
    },
  };
}

export function buildCornerstoneToolSpecs(): MaCustomToolSpec[] {
  return [
    getContextSpec(),
    searchSpec(),
    listFactsSpec(),
    recallSpec(),
    addFactSpec(),
    saveConversationSpec(),
    stewardInspectSpec(),
    stewardAdviseSpec(),
    stewardPreviewSpec(),
    stewardApplySpec(),
    stewardStatusSpec(),
  ];
}
