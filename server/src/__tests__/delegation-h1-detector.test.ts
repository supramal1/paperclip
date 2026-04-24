import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "@paperclipai/adapter-managed-agents/server";
import type {
  AdapterExecutionContext,
  DelegationRequest,
  DelegationResult,
} from "@paperclipai/adapter-utils";

// -----------------------------------------------------------------------------
// H1 detector — session terminates before tool_result resumes the model
//
// Context (2026-04-24, Ada's run 5fc47c80):
//   Ada's MA session emitted agent.custom_tool_use + session.status_idle in the
//   same batch with stop_reason="completed". The adapter called delegateTask
//   (which succeeded — Donald wrote 7956 chars to his heartbeat_run.resultJson),
//   then posted user.custom_tool_result back to MA. But MA never ran a second
//   turn for Ada — her heartbeat_run showed cacheReadTokens=0 (definitive proof
//   the session made only one API call) and her finalText was her 168-char
//   pre-delegation preamble, not Donald's audit.
//
// The invariant this test locks in:
//   For each agent.custom_tool_use event observed, there must be at least one
//   *subsequent* span.model_request_end event in the session's event stream.
//   span count must be >= customToolUseCount + 1 (initial span + one synthesis
//   span per tool_use). If not, MA abandoned the session before running the
//   synthesis turn — classify as failure so the reconciler can retry instead
//   of silently returning a preamble-only result.
//
// This test drives the adapter's execute() with a scripted fetch mock that
// simulates exactly the H1 event sequence. It exists to prevent the adapter
// from ever again silently classifying an un-resumed session as success.
// -----------------------------------------------------------------------------

type MaEventStub = {
  id: string;
  type: string;
  [k: string]: unknown;
};

type FetchResponse = { status: number; body: unknown };
type FetchHandler = (method: string, path: string, body: unknown) => FetchResponse;

function installMaFetch(handler: FetchHandler): {
  calls: Array<{ method: string; path: string; body: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const orig = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = init?.body ? JSON.parse(init.body as string) : null;
    const path = new URL(url).pathname;
    calls.push({ method, path, body: parsed });
    const { status, body } = handler(method, path, parsed);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      global.fetch = orig;
    },
  };
}

function buildCtx(opts: {
  runId: string;
  delegateTask: (req: DelegationRequest) => Promise<DelegationResult>;
}): AdapterExecutionContext {
  return {
    runId: opts.runId,
    agent: {
      id: "ada-agent-uuid",
      companyId: "charlie-oscar-uuid",
      name: "Ada",
      adapterType: "managed_agents",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "h1-test",
    },
    config: {
      role: "Lead agent",
      model: "claude-haiku-4-5-20251001",
      timeoutSec: 10,
    },
    context: {
      taskBody: "Synthesize Donald's audit",
    },
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
    delegateTask: opts.delegateTask,
  };
}

describe("adapter managed-agents — H1 detector", () => {
  // Save + clear env vars that would cause the adapter to make real network
  // calls to Cornerstone / Cookbook. The test only exercises MA via mock.
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "ANTHROPIC_API_KEY",
    "CORNERSTONE_API_KEY",
    "MEMORY_API_KEY",
    "COOKBOOK_ACCESS_TOKEN",
    "COOKBOOK_API_KEY",
    "COOKBOOK_MOCK_MODE",
  ];

  beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    for (const k of envKeys) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "test-key-mocked-not-used";
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("flags H1 when custom_tool_use produces no subsequent synthesis span", async () => {
    const SESSION_ID = "sesn_test_h1_01";
    const AGENT_ID = "agnt_test_h1";
    const ENV_ID = "envr_test_h1";
    const TOOL_USE_ID = "sevt_tool_use_h1";
    const RUN_ID = "parent-run-uuid-h1";

    // Events present BEFORE the custom tool handler posts a tool_result.
    // Note: session.status_idle with stop_reason="end_turn" (NOT "tool_use")
    // is the H1 smoking gun — MA signaled the turn ended, so the tool_result
    // post after this point will be a no-op.
    const preEvents: MaEventStub[] = [
      {
        id: "sevt_span_1",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 3,
          output_tokens: 984,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19300,
        },
      },
      {
        id: "sevt_msg_1",
        type: "agent.message",
        content: [{ type: "text", text: "I'll delegate this to Donald." }],
      },
      {
        id: TOOL_USE_ID,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "Audit",
          description: "Do the thing",
          wait: true,
        },
      },
      {
        id: "sevt_idle_1",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ];

    let toolResultPosted = false;

    const mock = installMaFetch((method, path, body) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: AGENT_ID,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "test",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: ENV_ID, state: "ready", name: "test" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
            },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") {
          toolResultPosted = true;
          return {
            status: 200,
            body: {
              data: [
                {
                  id: "sevt_tool_result_echo",
                  type: "user.custom_tool_result",
                  custom_tool_use_id: ev.custom_tool_use_id,
                },
              ],
            },
          };
        }
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        if (!toolResultPosted) {
          return { status: 200, body: { data: preEvents } };
        }
        // H1: session accepts the tool_result post + emits a second idle,
        // but NO new span.model_request_end — MA never ran the synthesis turn.
        return {
          status: 200,
          body: {
            data: [
              ...preEvents,
              {
                id: "sevt_tool_result_echo",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID,
              },
              {
                id: "sevt_idle_2",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "terminated",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 3,
              output_tokens: 984,
              cache_read_input_tokens: 0,
            },
            stats: { active_seconds: 25.7, duration_seconds: 120 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    // delegateTask succeeds (the child run completed normally). H1 is NOT
    // about delegation failure — it's about MA not resuming the PARENT.
    const delegateTask = async (): Promise<DelegationResult> => ({
      status: "completed",
      childRunId: "child-run-uuid",
      childIssueId: "child-issue-uuid",
      childIssueIdentifier: "DT-1",
      finalText: "Donald's full audit: 7956 chars of substance.",
      costUsd: 0.42,
      errorCode: null,
      errorMessage: null,
    });

    try {
      const result = await execute(buildCtx({ runId: RUN_ID, delegateTask }));

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("session_terminated_before_tool_result");
      expect(result.errorMeta).toMatchObject({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        customToolUseCount: 1,
        spanCount: 1,
      });
    } finally {
      mock.restore();
    }
  }, 20_000);

  it("does not flag healthy delegation where a synthesis span follows tool_result", async () => {
    const SESSION_ID = "sesn_test_healthy";
    const AGENT_ID = "agnt_healthy";
    const ENV_ID = "envr_healthy";
    const TOOL_USE_ID = "sevt_tool_use_healthy";

    const preEvents: MaEventStub[] = [
      {
        id: "sevt_span_pre",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 3,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 19300,
        },
      },
      {
        id: "sevt_msg_pre",
        type: "agent.message",
        content: [{ type: "text", text: "delegating" }],
      },
      {
        id: TOOL_USE_ID,
        type: "agent.custom_tool_use",
        name: "delegate_task",
        input: {
          assignee_agent_name: "Donald",
          title: "x",
          description: "y",
          wait: true,
        },
      },
      {
        id: "sevt_idle_pre",
        type: "session.status_idle",
        stop_reason: { type: "tool_use" },
      },
    ];

    let toolResultPosted = false;

    const mock = installMaFetch((method, path, body) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: AGENT_ID,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "t",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: ENV_ID, state: "r", name: "t" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
            },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        const rec = body as { events?: Array<Record<string, unknown>> } | null;
        const ev = rec?.events?.[0];
        if (ev?.type === "user.custom_tool_result") {
          toolResultPosted = true;
        }
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        if (!toolResultPosted) {
          return { status: 200, body: { data: preEvents } };
        }
        return {
          status: 200,
          body: {
            data: [
              ...preEvents,
              {
                id: "sevt_tool_result_echo",
                type: "user.custom_tool_result",
                custom_tool_use_id: TOOL_USE_ID,
              },
              {
                id: "sevt_span_post",
                type: "span.model_request_end",
                model_usage: {
                  input_tokens: 5,
                  output_tokens: 3000,
                  cache_read_input_tokens: 19300,
                  cache_creation_input_tokens: 0,
                },
              },
              {
                id: "sevt_msg_synthesis",
                type: "agent.message",
                content: [
                  {
                    type: "text",
                    text: "Synthesis: Donald's audit summary.",
                  },
                ],
              },
              {
                id: "sevt_idle_post",
                type: "session.status_idle",
                stop_reason: { type: "end_turn" },
              },
            ],
          },
        };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "idle",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: {
              input_tokens: 8,
              output_tokens: 3200,
              cache_read_input_tokens: 19300,
            },
            stats: { active_seconds: 135, duration_seconds: 160 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    const delegateTask = async (): Promise<DelegationResult> => ({
      status: "completed",
      childRunId: "c",
      childIssueId: "i",
      childIssueIdentifier: "X-1",
      finalText: "Donald output",
      costUsd: 0.1,
      errorCode: null,
      errorMessage: null,
    });

    try {
      const result = await execute(
        buildCtx({ runId: "healthy-run", delegateTask }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.errorCode ?? null).toBeNull();
      const rj = result.resultJson as Record<string, unknown> | undefined;
      expect(typeof rj?.finalText).toBe("string");
      expect(rj?.finalText as string).toContain("Synthesis");
    } finally {
      mock.restore();
    }
  }, 20_000);
});
