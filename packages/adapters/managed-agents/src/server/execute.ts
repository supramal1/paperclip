import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  DelegationRequest,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  createAgent,
  createEnvironment,
  createSession,
  getSession,
  listEvents,
  postUserMessage,
  postCustomToolResult,
  fetchCornerstoneContext,
  cookbookGetSkill,
  cookbookListSkills,
  type MaEvent,
  type MaCustomToolSpec,
  type CookbookSkillDetail,
} from "./client.js";
import { renderSystemPrompt, renderUserTurn } from "./prompt.js";
import { calcRuntimeCostUsd, calcTokenCostUsd } from "./cost.js";
import { cacheGet, cachePut } from "./cache.js";

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

// Paperclip injects desired skills in two shapes at runtime:
//   (a) cfg.paperclipRuntimeSkills — object array from companySkills.listRuntimeSkillEntries
//       (keys: key, runtimeName, required, source, …). Only non-empty when the
//       skill exists in the company_skills table.
//   (b) cfg.paperclipSkillSync.desiredSkills — plain string array, written by
//       POST /agents/:id/skills/sync via writePaperclipSkillSyncPreference.
// We union both so a skill can be injected without a company_skills row
// (spike mock path) and the normal runtime-entries path still works.
function collectRequestedSkillNames(cfg: Record<string, unknown>): string[] {
  const names: string[] = [];
  const runtime = cfg.paperclipRuntimeSkills;
  if (Array.isArray(runtime)) {
    for (const entry of runtime) {
      if (typeof entry === "string" && entry.trim()) {
        names.push(entry.trim());
      } else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const key = typeof rec.key === "string" ? rec.key.trim() : "";
        const runtimeName = typeof rec.runtimeName === "string" ? rec.runtimeName.trim() : "";
        if (key) names.push(key);
        else if (runtimeName) names.push(runtimeName);
      }
    }
  }
  const sync = cfg.paperclipSkillSync;
  if (sync && typeof sync === "object" && !Array.isArray(sync)) {
    const desired = (sync as Record<string, unknown>).desiredSkills;
    if (Array.isArray(desired)) {
      for (const value of desired) {
        if (typeof value === "string" && value.trim()) names.push(value.trim());
      }
    }
  }
  return Array.from(new Set(names));
}

async function getCornerstoneContextCached(
  memoryKey: string,
  namespace: string,
  query: string,
): Promise<string> {
  const hit = cacheGet<string>(namespace, query);
  if (hit !== null) return hit;
  try {
    const res = await fetchCornerstoneContext(memoryKey, {
      query,
      namespace,
      detailLevel: "minimal",
      maxTokens: 2000,
    });
    const out = res.context ?? "";
    cachePut(namespace, query, out);
    return out;
  } catch (err) {
    // Non-fatal — memory is optional, log and continue.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[managed_agents] Cornerstone fetch failed: ${msg}`);
    return "";
  }
}

async function fetchSkillBodies(
  memoryKey: string,
  names: string[],
): Promise<CookbookSkillDetail[]> {
  if (names.length === 0) return [];
  // Use allSettled — a missing/forbidden skill should not drop the ones that
  // DID resolve (e.g. spike-fixture under COOKBOOK_MOCK_MODE alongside other
  // runtime-entry names the mock doesn't know about).
  const results = await Promise.all(
    names.map(async (n): Promise<CookbookSkillDetail | null> => {
      try {
        const detail = await cookbookGetSkill(memoryKey, n);
        // Cookbook MCP responds 200 with an empty payload for unknown skills
        // rather than erroring; drop anything without usable content so
        // renderSystemPrompt doesn't blow up on undefined fields.
        if (!detail || typeof detail.content !== "string" || detail.content.trim().length === 0) {
          return null;
        }
        if (typeof detail.name !== "string" || detail.name.length === 0) {
          return null;
        }
        return detail;
      } catch (err) {
        console.warn(
          `[managed_agents] Cookbook get_skill("${n}") failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  return results.filter((s): s is CookbookSkillDetail => s !== null);
}

// Wait for session to return to idle after posting a user.message.
// Polls GET /v1/sessions/{id}/events every 500ms up to timeoutMs.
// Streams new events to ctx.onLog as they appear.
// When a custom tool use is detected and a handler is provided, the tool is
// dispatched inline and its result is posted back to the session so the loop
// can continue past the next idle. Events already seen by an earlier cycle
// (e.g. a `session.status_idle` raised before the tool result was posted) are
// ignored via `seenIds` so they don't falsely terminate the outer loop.
type CustomToolHandler = (ev: MaEvent) => Promise<void>;

async function waitForIdle(
  apiKey: string,
  sessionId: string,
  seenIds: Set<string>,
  onEvent: (ev: MaEvent) => Promise<void>,
  timeoutMs: number,
  onCustomTool?: CustomToolHandler,
): Promise<MaEvent[]> {
  const start = Date.now();
  const allNew: MaEvent[] = [];
  while (Date.now() - start < timeoutMs) {
    const { data } = await listEvents(apiKey, sessionId);
    let pendingCustomTool = false;
    let sawTerminalThisCycle = false;
    for (const ev of data) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
      allNew.push(ev);
      await onEvent(ev);
      if (ev.type === "agent.custom_tool_use" && onCustomTool) {
        await onCustomTool(ev);
        pendingCustomTool = true;
      }
      if (
        ev.type === "session.status_idle" ||
        ev.type === "session.status_terminated"
      ) {
        sawTerminalThisCycle = true;
      }
    }
    if (sawTerminalThisCycle && !pendingCustomTool) return allNew;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Session ${sessionId} did not reach idle within ${timeoutMs}ms`);
}

const DELEGATE_TASK_TOOL_NAME = "delegate_task";

function buildDelegateTaskToolSpec(): MaCustomToolSpec {
  return {
    name: DELEGATE_TASK_TOOL_NAME,
    description:
      "Delegate a unit of work to one of your direct reports. Creates an issue assigned to the named agent and (if wait=true) blocks until the child run finishes, returning its final output. Only direct reports can be assignees. Nested delegation requires the assignee to have canDelegate permission.",
    input_schema: {
      type: "object",
      properties: {
        assignee_agent_name: {
          type: "string",
          description: "Name of a direct-report agent (case-insensitive).",
        },
        title: {
          type: "string",
          description: "Short issue title for the delegated task (< 160 chars).",
        },
        description: {
          type: "string",
          description: "Full task description / prompt body for the assignee.",
        },
        wait: {
          type: "boolean",
          description: "If true (default), block until the child run completes or times out. Default true.",
        },
        timeout_seconds: {
          type: "integer",
          description: "Upper bound in seconds before returning status=timeout. Default 3600 (range 60-14400).",
        },
      },
      required: ["assignee_agent_name", "title", "description"],
    },
  };
}

function parseDelegateTaskInput(raw: unknown): DelegationRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "input must be an object" };
  const rec = raw as Record<string, unknown>;
  const assignee = rec.assignee_agent_name;
  const title = rec.title;
  const description = rec.description;
  if (typeof assignee !== "string" || assignee.trim().length === 0) {
    return { error: "assignee_agent_name is required" };
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return { error: "title is required" };
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return { error: "description is required" };
  }
  const wait = typeof rec.wait === "boolean" ? rec.wait : true;
  const timeout =
    typeof rec.timeout_seconds === "number" && rec.timeout_seconds > 0
      ? Math.floor(rec.timeout_seconds)
      : 3600;
  return {
    assigneeAgentName: assignee.trim(),
    title: title.trim().slice(0, 200),
    description,
    waitForCompletion: wait,
    timeoutSeconds: Math.min(Math.max(timeout, 60), 14400),
  };
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "ANTHROPIC_API_KEY_MISSING",
      errorMessage: "ANTHROPIC_API_KEY not set on the Paperclip server",
    };
  }
  const cornerstoneKey =
    process.env.CORNERSTONE_API_KEY ?? process.env.MEMORY_API_KEY ?? "";
  // Prefer the OAuth-minted bridge token (set post-spike). Fall back to the
  // legacy API key envs so the mock path and older deploys keep working.
  const cookbookKey =
    process.env.COOKBOOK_ACCESS_TOKEN ??
    process.env.COOKBOOK_API_KEY ??
    process.env.MEMORY_API_KEY ??
    "";

  const cfg = ctx.config as Record<string, unknown>;
  const role = readString(cfg.role) ?? "A helpful Paperclip workforce agent.";
  const model = readString(cfg.model) ?? "claude-haiku-4-5-20251001";
  const namespace = readString(cfg.cornerstoneNamespace) ?? "default";
  const outputFormat = readString(cfg.outputFormat) ?? undefined;
  const timeoutSec =
    typeof cfg.timeoutSec === "number" && cfg.timeoutSec > 0 ? cfg.timeoutSec : 600;
  const requestedSkillNames = collectRequestedSkillNames(cfg);
  await ctx.onLog(
    "stdout",
    JSON.stringify({
      managed_agents_debug: "skill_request",
      cfgKeys: Object.keys(cfg),
      hasPaperclipSkillSync: Boolean(cfg.paperclipSkillSync),
      hasPaperclipRuntimeSkills: Boolean(cfg.paperclipRuntimeSkills),
      requestedSkillNames,
      cookbookKeyPresent: Boolean(cookbookKey),
      cookbookMockMode: process.env.COOKBOOK_MOCK_MODE === "true",
    }) + "\n",
  );

  // Task body comes in via ctx.context.taskBody per paperclip convention.
  // For issue_assigned / comment-driven wakeups the harness does not populate
  // taskBody directly — it provides ctx.context.paperclipWake which every
  // other adapter renders via renderPaperclipWakePrompt. Fall back to that so
  // managed_agents runs on assignment wakeups behave like the others.
  const taskCtx = ctx.context as Record<string, unknown>;
  const explicitTaskBody =
    readString(taskCtx.taskBody) ??
    readString(taskCtx.body) ??
    readString(taskCtx.prompt);
  const wakePrompt = renderPaperclipWakePrompt(taskCtx.paperclipWake, {
    resumedSession: Boolean(readString((ctx.runtime.sessionParams ?? {}).sessionId)),
  });
  const taskBody = explicitTaskBody ?? (wakePrompt.trim().length > 0 ? wakePrompt : "");
  const taskKey = readString(taskCtx.taskKey) ?? ctx.runtime.taskKey ?? null;

  if (!taskBody) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "MISSING_TASK_BODY",
      errorMessage: "ctx.context did not include a taskBody / body / prompt / paperclipWake",
    };
  }

  const existing = ctx.runtime.sessionParams ?? {};
  let agentId = readString(existing.agentId) ?? readString(cfg.agentId);
  let agentVersion: number | undefined =
    typeof existing.agentVersion === "number" ? existing.agentVersion : undefined;
  let environmentId = readString(existing.environmentId) ?? readString(cfg.environmentId);
  let sessionId = readString(existing.sessionId);

  await ctx.onMeta?.({
    adapterType: "managed_agents",
    command: "managed-agents-api",
    context: {
      model,
      role,
      namespace,
      taskKey,
      reuseAgent: Boolean(agentId),
      reuseEnv: Boolean(environmentId),
    },
  });

  // ---------------------------------------------------------------
  // Parallel: (1) fetch Cornerstone memory context, (2) ensure agent + env exist
  // ---------------------------------------------------------------
  const cornerstoneQuery = `${role}: ${taskBody.slice(0, 200)}`;

  const [cornerstoneContext, skills, resolvedAgent, resolvedEnv] = await Promise.all([
    cornerstoneKey
      ? getCornerstoneContextCached(cornerstoneKey, namespace, cornerstoneQuery)
      : Promise.resolve(""),
    cookbookKey ? fetchSkillBodies(cookbookKey, requestedSkillNames) : Promise.resolve([]),
    agentId
      ? Promise.resolve({ id: agentId, version: agentVersion ?? 1 })
      : (async () => {
          const customTools = ctx.delegateTask
            ? [buildDelegateTaskToolSpec()]
            : undefined;
          const a = await createAgent(apiKey, {
            name: `paperclip-${ctx.agent.companyId.slice(0, 8)}-${ctx.agent.id.slice(0, 8)}`,
            model,
            system: "bootstrap",
            customTools,
          });
          return { id: a.id, version: a.version };
        })(),
    environmentId
      ? Promise.resolve({ id: environmentId })
      : (async () => {
          const e = await createEnvironment(apiKey, `paperclip-${ctx.agent.id.slice(0, 8)}`);
          return { id: e.id };
        })(),
  ]);

  agentId = resolvedAgent.id;
  agentVersion = resolvedAgent.version;
  environmentId = resolvedEnv.id;

  await ctx.onLog(
    "stdout",
    JSON.stringify({
      managed_agents_debug: "skill_fetch_result",
      requestedCount: requestedSkillNames.length,
      fetchedCount: skills.length,
      fetchedNames: skills.map((s) => s.name),
      fetchedContentLengths: skills.map((s) => s.content?.length ?? 0),
    }) + "\n",
  );

  // Render the system prompt & user turn. For the spike we don't update
  // the stored agent's system prompt on every run — we inject the fully
  // rendered prompt as the first message. POST /v1/agents/{id} should be
  // called once per real config change (role, skills) in a follow-up.
  const systemPrompt = renderSystemPrompt({
    role,
    outputFormat,
    cornerstoneContext,
    skills,
    task: { key: taskKey, body: taskBody },
  });
  const userTurn = renderUserTurn({
    role,
    outputFormat,
    cornerstoneContext,
    skills,
    task: { key: taskKey, body: taskBody },
  });

  // New session per run for the MVP. Resumable session continuation is a
  // follow-up: we'd reuse `sessionId` from runtime.sessionParams instead.
  const session = await createSession(apiKey, {
    agentId,
    environmentId,
    agentVersion,
  });
  sessionId = session.id;

  await ctx.onSpawn?.({
    pid: 0, // remote session — no local pid
    processGroupId: null,
    startedAt: new Date().toISOString(),
  });

  // Combine system+user into a single user.message for the first (and currently
  // only) turn. The Managed Agents system prompt was set at agent creation time;
  // we prefix it here as a reminder because we didn't rewrite the agent version.
  const firstMessage = `${systemPrompt}\n\n---\n\n${userTurn}`;
  await postUserMessage(apiKey, sessionId, firstMessage);

  const seen = new Set<string>();
  const onEvent = async (ev: MaEvent): Promise<void> => {
    // Stream to Paperclip's transcript via onLog. Adapter UI parser can
    // be added later (docs/adapters/adapter-ui-parser.md); for now we
    // just dump each event as a JSON line on stdout.
    await ctx.onLog("stdout", JSON.stringify({ managed_agents_event: ev.type, id: ev.id, ...(ev.content ? { content: ev.content } : {}), ...(ev.model_usage ? { model_usage: ev.model_usage } : {}) }) + "\n");
  };

  const delegateTask = ctx.delegateTask;
  const onCustomTool: CustomToolHandler | undefined = delegateTask
    ? async (ev: MaEvent) => {
        // On agent.custom_tool_use, the event's own `id` is the tool_use_id
        // (no separate tool_use_id field exists). name/input are flat on the
        // event. Also tolerate the content-block shape
        // {type:"tool_use", id, name, input} for forward compat.
        const flatName = typeof ev.name === "string" ? ev.name : null;
        const flatInput = ev.input;
        const contentBlocks = Array.isArray(ev.content) ? ev.content : [];
        const toolBlock = contentBlocks.find(
          (c): c is { type: string; id?: string; name?: string; input?: unknown } =>
            !!c && typeof c === "object" && (c as { type?: unknown }).type === "tool_use",
        );
        const flatToolUseId =
          typeof ev.tool_use_id === "string"
            ? ev.tool_use_id
            : typeof ev.id === "string" && ev.type === "agent.custom_tool_use"
              ? ev.id
              : null;
        const toolUseId =
          flatToolUseId ?? (toolBlock && typeof toolBlock.id === "string" ? toolBlock.id : null);
        const name =
          flatName ?? (toolBlock && typeof toolBlock.name === "string" ? toolBlock.name : null);
        const input = flatInput ?? toolBlock?.input;
        await ctx.onLog(
          "stdout",
          JSON.stringify({
            managed_agents_debug: "custom_tool_use_received",
            evId: ev.id,
            toolUseId,
            name,
            hasInput: input !== undefined,
            rawEventKeys: Object.keys(ev),
          }) + "\n",
        );
        if (!toolUseId || !name) return;
        if (name !== DELEGATE_TASK_TOOL_NAME) {
          await postCustomToolResult(
            apiKey,
            sessionId,
            toolUseId,
            JSON.stringify({ error: `unknown tool: ${name}` }),
            true,
          );
          return;
        }
        const parsed = parseDelegateTaskInput(input);
        if ("error" in parsed) {
          await postCustomToolResult(
            apiKey,
            sessionId,
            toolUseId,
            JSON.stringify({ error: parsed.error }),
            true,
          );
          return;
        }
        try {
          const result = await delegateTask(parsed);
          await postCustomToolResult(
            apiKey,
            sessionId,
            toolUseId,
            JSON.stringify(result),
            result.status === "failed" ||
              result.status === "rejected" ||
              result.status === "timeout",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await postCustomToolResult(
            apiKey,
            sessionId,
            toolUseId,
            JSON.stringify({ error: msg, status: "failed" }),
            true,
          );
        }
      }
    : undefined;

  const newEvents = await waitForIdle(
    apiKey,
    sessionId,
    seen,
    onEvent,
    timeoutSec * 1000,
    onCustomTool,
  );

  // Aggregate usage + final response
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let finalText = "";
  let isError = false;
  let stopReason: string | null = null;

  for (const ev of newEvents) {
    if (ev.type === "span.model_request_end" && ev.model_usage) {
      inputTokens += ev.model_usage.input_tokens;
      outputTokens += ev.model_usage.output_tokens;
      cacheReadTokens += ev.model_usage.cache_read_input_tokens;
      cacheCreateTokens += ev.model_usage.cache_creation_input_tokens;
      if (ev.is_error) isError = true;
    }
    if (ev.type === "agent.message" && ev.content) {
      const text = ev.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      if (text) finalText = text;
    }
    if (ev.type === "session.status_idle" && ev.stop_reason) {
      stopReason = ev.stop_reason.type;
    }
  }

  // Pull final session state for runtime cost
  const finalSession = await getSession(apiKey, sessionId);
  const activeSeconds = finalSession.stats?.active_seconds ?? 0;
  const tokenCost = calcTokenCostUsd(model, {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreateTokens,
    cacheReadInputTokens: cacheReadTokens,
  });
  const runtimeCost = calcRuntimeCostUsd(activeSeconds);
  const costUsd = tokenCost + runtimeCost;

  return {
    exitCode: isError ? 1 : 0,
    signal: null,
    timedOut: false,
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheReadTokens,
    },
    sessionParams: {
      sessionId,
      agentId,
      agentVersion,
      environmentId,
    },
    sessionDisplayId: sessionId,
    provider: "anthropic",
    biller: "anthropic",
    model,
    billingType: "api",
    costUsd,
    resultJson: {
      managedAgentsSessionId: sessionId,
      activeSeconds,
      tokenCostUsd: tokenCost,
      runtimeCostUsd: runtimeCost,
      stopReason,
      cacheReadTokens,
      cacheCreateTokens,
      finalText,
    },
    summary: finalText.slice(0, 280) || null,
  };
}
