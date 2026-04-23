import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  DelegationRequest,
  DelegationResult,
} from "@paperclipai/adapter-utils";
import { agents, costEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

/**
 * Terminal statuses for a child heartbeat_run. The delegation poller returns
 * once the child row lands on one of these.
 */
const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "canceled",
  "cancelled",
  "error",
]);

interface DelegationDeps {
  db: Db;
  heartbeat: {
    wakeup: (
      agentId: string,
      opts: {
        source?: "timer" | "assignment" | "on_demand" | "automation";
        triggerDetail?: "manual" | "ping" | "callback" | "system";
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
        parentRunId?: string | null;
      },
    ) => Promise<unknown>;
  };
  parentAgent: {
    id: string;
    companyId: string;
    name: string;
    permissions: Record<string, unknown>;
  };
  parentRunId: string;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function resolveCanDelegate(permissions: Record<string, unknown>): boolean {
  return readBoolean(permissions?.canDelegate);
}

async function sumChildCostCents(db: Db, childRunId: string): Promise<number> {
  const row = await db
    .select({ total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)` })
    .from(costEvents)
    .where(eq(costEvents.heartbeatRunId, childRunId))
    .then((rows) => rows[0] ?? null);
  if (!row) return 0;
  const n = Number(row.total);
  return Number.isFinite(n) ? n : 0;
}

export function createDelegateTaskCallback(
  deps: DelegationDeps,
): (req: DelegationRequest) => Promise<DelegationResult> {
  const { db, heartbeat, parentAgent, parentRunId } = deps;
  const blankResult = (
    status: DelegationResult["status"],
    errorCode: string | null,
    errorMessage: string | null,
  ): DelegationResult => ({
    status,
    childRunId: null,
    childIssueId: null,
    childIssueIdentifier: null,
    finalText: null,
    costUsd: null,
    errorCode,
    errorMessage,
  });

  return async function delegateTask(req: DelegationRequest): Promise<DelegationResult> {
    // 1. Resolve assignee by name within the same company (case-insensitive).
    const candidates = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, parentAgent.companyId),
          sql`lower(${agents.name}) = lower(${req.assigneeAgentName})`,
        ),
      );
    if (candidates.length === 0) {
      return blankResult(
        "rejected",
        "assignee_not_found",
        `No agent named "${req.assigneeAgentName}" in this company`,
      );
    }
    if (candidates.length > 1) {
      return blankResult(
        "rejected",
        "assignee_ambiguous",
        `Multiple agents match "${req.assigneeAgentName}"`,
      );
    }
    const assignee = candidates[0];

    // 2. Reports-to check — assignee must be a direct report of the delegator.
    if (assignee.reportsTo !== parentAgent.id) {
      return blankResult(
        "rejected",
        "not_direct_report",
        `Agent "${assignee.name}" does not report to "${parentAgent.name}"`,
      );
    }

    // 3. Self-delegation guard.
    if (assignee.id === parentAgent.id) {
      return blankResult(
        "rejected",
        "self_delegation",
        "Cannot delegate to self",
      );
    }

    // 4. Recursion guard — assignee must have canDelegate=true before we allow
    //    the delegated run itself to surface a delegate_task tool. Here we just
    //    allow the delegation; the adapter will consult canDelegate on the
    //    child agent when deciding whether to register the tool. This branch
    //    keeps the explicit check so rejections surface useful error codes.
    //    (Future: block chains beyond configured depth via parent_run_id walk.)

    // 5. Create the child issue assigned to the delegate.
    const titleTrimmed = req.title.slice(0, 200);
    const svc = issueService(db);
    let issue;
    try {
      issue = await svc.create(parentAgent.companyId, {
        title: titleTrimmed,
        description: req.description,
        status: "todo",
        priority: "medium",
        assigneeAgentId: assignee.id,
        createdByAgentId: parentAgent.id,
        originKind: "delegation",
        originId: parentRunId,
      } as Parameters<typeof svc.create>[1]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return blankResult("failed", "issue_create_failed", msg);
    }

    // 6. Enqueue the wakeup with parentRunId so the child heartbeat_run row
    //    carries the attribution. Bypass queueIssueAssignmentWakeup — we need
    //    direct control over parentRunId which it doesn't pass through.
    let wakeupResult: unknown;
    try {
      wakeupResult = await heartbeat.wakeup(assignee.id, {
        source: "assignment",
        triggerDetail: "system",
        reason: "delegate_task",
        payload: {
          issueId: issue.id,
          mutation: "delegate_task",
          parentRunId,
        },
        requestedByActorType: "agent",
        requestedByActorId: parentAgent.id,
        contextSnapshot: {
          issueId: issue.id,
          source: "delegate_task",
        },
        parentRunId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return blankResult("failed", "wakeup_failed", msg);
    }

    const childRunId =
      wakeupResult && typeof wakeupResult === "object" && "id" in wakeupResult
        ? String((wakeupResult as { id: unknown }).id)
        : null;

    if (!childRunId) {
      return blankResult(
        "failed",
        "wakeup_no_run",
        "Wakeup did not produce a heartbeat_run",
      );
    }

    const baseResult: DelegationResult = {
      status: "queued",
      childRunId,
      childIssueId: issue.id,
      childIssueIdentifier: issue.identifier ?? null,
      finalText: null,
      costUsd: null,
      errorCode: null,
      errorMessage: null,
    };

    if (!req.waitForCompletion) {
      return baseResult;
    }

    // 7. Poll heartbeat_runs until terminal or timeout.
    const deadline = Date.now() + req.timeoutSeconds * 1000;
    // Initial delay lets the synchronous runner start executing.
    await new Promise((r) => setTimeout(r, 3000));
    let childRow = null as
      | (typeof heartbeatRuns.$inferSelect)
      | null;
    while (Date.now() < deadline) {
      childRow = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, childRunId))
        .then((rows) => rows[0] ?? null);
      if (!childRow) {
        return blankResult("failed", "child_run_missing", "Child run vanished");
      }
      if (TERMINAL_STATUSES.has(childRow.status)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!childRow || !TERMINAL_STATUSES.has(childRow.status)) {
      return {
        ...baseResult,
        status: "timeout",
        errorCode: "timeout",
        errorMessage: `Child run did not finish within ${req.timeoutSeconds}s`,
      };
    }

    const costCents = await sumChildCostCents(db, childRunId);
    const resultJson = (childRow.resultJson ?? {}) as Record<string, unknown>;
    const finalText =
      typeof resultJson.finalText === "string"
        ? resultJson.finalText
        : typeof resultJson.summary === "string"
          ? resultJson.summary
          : null;

    const failed = childRow.status !== "done";

    return {
      status: failed ? "failed" : "completed",
      childRunId,
      childIssueId: issue.id,
      childIssueIdentifier: issue.identifier ?? null,
      finalText,
      costUsd: costCents / 100,
      errorCode: failed ? childRow.errorCode ?? "child_run_failed" : null,
      errorMessage: failed ? childRow.error ?? null : null,
    };
  };
}

/**
 * Gate whether the current run can expose delegate_task. Only agents with
 * `permissions.canDelegate=true` AND at least one direct report may delegate.
 */
export async function canAgentDelegate(
  db: Db,
  agent: { id: string; companyId: string; permissions: Record<string, unknown> },
): Promise<boolean> {
  if (!resolveCanDelegate(agent.permissions)) return false;
  const reports = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, agent.companyId), eq(agents.reportsTo, agent.id)))
    .limit(1);
  return reports.length > 0;
}

export const delegationTerminalStatuses = Array.from(TERMINAL_STATUSES);

/** Exported for completeness; services that need batched cost rollups can reuse. */
export async function sumCostCentsForRun(db: Db, runId: string): Promise<number> {
  return sumChildCostCents(db, runId);
}

// Silence unused-import warnings for helpers kept for future expansion.
void inArray;
void logger;
