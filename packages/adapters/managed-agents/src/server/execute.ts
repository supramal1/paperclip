import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  createAgent,
  createEnvironment,
  createSession,
  getSession,
  listEvents,
  postUserMessage,
  fetchCornerstoneContext,
  cookbookGetSkill,
  cookbookListSkills,
  type MaEvent,
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
async function waitForIdle(
  apiKey: string,
  sessionId: string,
  seenIds: Set<string>,
  onEvent: (ev: MaEvent) => Promise<void>,
  timeoutMs: number,
): Promise<MaEvent[]> {
  const start = Date.now();
  const allNew: MaEvent[] = [];
  while (Date.now() - start < timeoutMs) {
    const { data } = await listEvents(apiKey, sessionId);
    for (const ev of data) {
      if (seenIds.has(ev.id)) continue;
      seenIds.add(ev.id);
      allNew.push(ev);
      await onEvent(ev);
    }
    const terminal = data.find(
      (e) => e.type === "session.status_idle" || e.type === "session.status_terminated",
    );
    if (terminal) return allNew;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Session ${sessionId} did not reach idle within ${timeoutMs}ms`);
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
  const taskCtx = ctx.context as Record<string, unknown>;
  const taskBody =
    readString(taskCtx.taskBody) ??
    readString(taskCtx.body) ??
    readString(taskCtx.prompt) ??
    "";
  const taskKey = readString(taskCtx.taskKey) ?? ctx.runtime.taskKey ?? null;

  if (!taskBody) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "MISSING_TASK_BODY",
      errorMessage: "ctx.context did not include a taskBody / body / prompt",
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
          const a = await createAgent(apiKey, {
            name: `paperclip-${ctx.agent.companyId.slice(0, 8)}-${ctx.agent.id.slice(0, 8)}`,
            model,
            system: "bootstrap",
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

  const newEvents = await waitForIdle(apiKey, sessionId, seen, onEvent, timeoutSec * 1000);

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
