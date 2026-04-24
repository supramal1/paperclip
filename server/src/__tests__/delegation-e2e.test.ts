import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  canAgentDelegate,
  createDelegateTaskCallback,
} from "../services/delegation.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// -----------------------------------------------------------------------------
// Phase 0D acceptance tests for `delegate_task` (6 scenarios).
//
// Split by shape:
//   Unit (always run):
//     - Test 2: recursion guard via canAgentDelegate()
//     - Test 3: case-insensitive assignee name resolution
//     - Test 4: not-a-direct-report rejection
//   E2E (only with PAPERCLIP_E2E=1, requires live paperclip server +
//        ANTHROPIC_API_KEY with managed-agents beta access):
//     - Test 1: basic sync delegation round-trip
//     - Test 5: timeout characterization
//     - Test 6: waitForCompletion=false characterization
// -----------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeUnit = embeddedPostgresSupport.supported ? describe : describe.skip;

interface SeededCompany {
  companyId: string;
  parentAgent: { id: string; companyId: string; name: string; permissions: Record<string, unknown> };
  directReport: { id: string; name: string };
  unrelatedAgent: { id: string; name: string };
  childNoDelegate: { id: string; name: string; permissions: Record<string, unknown> };
}

async function seedDelegationCompany(db: Db): Promise<SeededCompany> {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `delegation-test-${companyId.slice(0, 8)}`,
    issuePrefix: `DT${companyId.slice(0, 3).toUpperCase()}`,
  } as Parameters<typeof db.insert>[0] extends unknown ? Record<string, unknown> : never);

  const parentId = randomUUID();
  const directId = randomUUID();
  const unrelatedId = randomUUID();
  const childNoDelId = randomUUID();

  await db.insert(agents).values([
    {
      id: parentId,
      companyId,
      name: "CEO",
      role: "ceo",
      reportsTo: null,
      adapterType: "managed_agents",
      permissions: { canDelegate: true },
    },
    {
      id: directId,
      companyId,
      name: "Direct Report",
      role: "general",
      reportsTo: parentId,
      adapterType: "managed_agents",
      permissions: { canDelegate: false },
    },
    {
      id: unrelatedId,
      companyId,
      name: "Unrelated",
      role: "general",
      reportsTo: null,
      adapterType: "managed_agents",
      permissions: { canDelegate: false },
    },
    {
      id: childNoDelId,
      companyId,
      name: "Child Without Delegate",
      role: "general",
      reportsTo: parentId,
      adapterType: "managed_agents",
      permissions: { canDelegate: false },
    },
  ]);

  return {
    companyId,
    parentAgent: { id: parentId, companyId, name: "CEO", permissions: { canDelegate: true } },
    directReport: { id: directId, name: "Direct Report" },
    unrelatedAgent: { id: unrelatedId, name: "Unrelated" },
    childNoDelegate: { id: childNoDelId, name: "Child Without Delegate", permissions: { canDelegate: false } },
  };
}

async function cleanupCompany(db: Db, companyId: string) {
  await db.delete(agents).where(eq(agents.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
}

describeUnit("delegation — unit", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delegation-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    if (cleanupIds.length > 0) {
      await db.delete(issues).where(inArray(issues.companyId, cleanupIds));
      await db.delete(agents).where(inArray(agents.companyId, cleanupIds));
      await db.delete(companies).where(inArray(companies.id, cleanupIds));
      cleanupIds.length = 0;
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // -------------------------------------------------------------------------
  // Test 2 — Recursion guard: canAgentDelegate() returns false for a child
  // agent lacking permissions.canDelegate, so the adapter sees
  // ctx.delegateTask=undefined and does NOT pass customTools to createAgent
  // (packages/adapters/managed-agents/src/server/execute.ts:340-342).
  // -------------------------------------------------------------------------
  it("Test 2 — canAgentDelegate returns false for child without canDelegate (recursion guard)", async () => {
    const seed = await seedDelegationCompany(db);
    cleanupIds.push(seed.companyId);

    const parentAllowed = await canAgentDelegate(db, {
      id: seed.parentAgent.id,
      companyId: seed.companyId,
      permissions: seed.parentAgent.permissions,
    });
    expect(parentAllowed).toBe(true);

    const childAllowed = await canAgentDelegate(db, {
      id: seed.childNoDelegate.id,
      companyId: seed.companyId,
      permissions: seed.childNoDelegate.permissions,
    });
    expect(childAllowed).toBe(false);

    const parentWithoutFlag = await canAgentDelegate(db, {
      id: seed.parentAgent.id,
      companyId: seed.companyId,
      permissions: {},
    });
    expect(parentWithoutFlag).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Case-insensitive name resolution. Delegating with an uppercased
  // assignee name should resolve to the same direct report.
  // -------------------------------------------------------------------------
  it("Test 3 — case-insensitive assignee resolution", async () => {
    const seed = await seedDelegationCompany(db);
    cleanupIds.push(seed.companyId);

    let wakeupCalledWithAgentId: string | null = null;
    const stubRunId = randomUUID();

    const delegateTask = createDelegateTaskCallback({
      db,
      heartbeat: {
        wakeup: async (agentId: string) => {
          wakeupCalledWithAgentId = agentId;
          return { id: stubRunId };
        },
      },
      parentAgent: seed.parentAgent,
      parentRunId: randomUUID(),
    });

    const result = await delegateTask({
      assigneeAgentName: "DIRECT REPORT",
      title: "Test delegation",
      description: "Verify name resolution ignores case",
      waitForCompletion: false,
      timeoutSeconds: 30,
    });

    expect(result.status).toBe("queued");
    expect(result.childRunId).toBe(stubRunId);
    expect(result.errorCode).toBeNull();
    expect(wakeupCalledWithAgentId).toBe(seed.directReport.id);
  });

  // -------------------------------------------------------------------------
  // Test 4 — Not-a-direct-report rejection. Target resolves (same company)
  // but does not reportsTo the parent agent.
  // -------------------------------------------------------------------------
  it("Test 4 — rejects delegation when target is not a direct report", async () => {
    const seed = await seedDelegationCompany(db);
    cleanupIds.push(seed.companyId);

    let wakeupCalled = false;
    const delegateTask = createDelegateTaskCallback({
      db,
      heartbeat: {
        wakeup: async () => {
          wakeupCalled = true;
          return { id: randomUUID() };
        },
      },
      parentAgent: seed.parentAgent,
      parentRunId: randomUUID(),
    });

    const result = await delegateTask({
      assigneeAgentName: seed.unrelatedAgent.name,
      title: "Should reject",
      description: "Unrelated agent doesn't report to parent",
      waitForCompletion: false,
      timeoutSeconds: 30,
    });

    expect(result.status).toBe("rejected");
    expect(result.errorCode).toBe("not_direct_report");
    expect(result.childRunId).toBeNull();
    expect(wakeupCalled).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// E2E tests (1, 5, 6) — behind PAPERCLIP_E2E=1. Require:
//   - live paperclip dev server (default http://localhost:3100)
//   - DATABASE_URL pointing at the same DB the server writes to
//   - server configured with ANTHROPIC_API_KEY + managed-agents beta access
// -----------------------------------------------------------------------------
const E2E_ENABLED = process.env.PAPERCLIP_E2E === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;
const BASE_URL = (process.env.PAPERCLIP_E2E_BASE_URL ?? "http://localhost:3100").replace(/\/+$/, "");
const E2E_DATABASE_URL = process.env.DATABASE_URL ?? process.env.PAPERCLIP_E2E_DATABASE_URL ?? null;

async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`DELETE ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function pollRun(
  db: Db,
  runId: string,
  predicate: (row: typeof heartbeatRuns.$inferSelect) => boolean,
  timeoutMs: number,
): Promise<typeof heartbeatRuns.$inferSelect | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (row && predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

describeE2E("delegation — e2e (live server)", () => {
  let db: Db;
  const createdCompanyIds: string[] = [];

  beforeAll(async () => {
    if (!E2E_DATABASE_URL) {
      throw new Error(
        "PAPERCLIP_E2E=1 requires DATABASE_URL (pointing at the dev server's DB) for heartbeat_run assertions.",
      );
    }
    db = createDb(E2E_DATABASE_URL);

    const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json()).catch(() => null);
    if (!health) throw new Error(`Cannot reach ${BASE_URL}/api/health — is the dev server running?`);
  }, 30_000);

  afterAll(async () => {
    for (const companyId of createdCompanyIds) {
      await apiDelete(`/api/companies/${companyId}`).catch(() => undefined);
    }
  }, 60_000);

  async function provisionCompany(): Promise<{ companyId: string; parentId: string; reportId: string }> {
    const nonce = randomUUID().slice(0, 8);
    const company = await apiPost<{ id: string }>("/api/companies", {
      name: `delegation-test-${nonce}`,
    });
    createdCompanyIds.push(company.id);

    const parent = await apiPost<{ id: string }>(`/api/companies/${company.id}/agents`, {
      name: "CEO",
      role: "ceo",
      adapterType: "managed_agents",
      adapterConfig: { model: "claude-sonnet-4-6" },
      permissions: { canDelegate: true },
    });
    const report = await apiPost<{ id: string }>(`/api/companies/${company.id}/agents`, {
      name: "Direct Report",
      role: "general",
      reportsTo: parent.id,
      adapterType: "managed_agents",
      adapterConfig: { model: "claude-sonnet-4-6" },
      permissions: { canDelegate: false },
    });

    return { companyId: company.id, parentId: parent.id, reportId: report.id };
  }

  // -------------------------------------------------------------------------
  // Test 1 — Basic sync delegation. Parent CEO delegates to a direct report
  // with waitForCompletion=true; expect status="completed", finalText set,
  // child.parent_run_id = parent.id, costUsd > 0.
  // -------------------------------------------------------------------------
  it("Test 1 — basic sync delegation round-trip", async () => {
    const { companyId, parentId } = await provisionCompany();
    const issue = await apiPost<{ id: string }>(`/api/companies/${companyId}/issues`, {
      title: "Parent: delegate 'say hello' to your direct report",
      description:
        'Call delegate_task with assigneeAgentName="Direct Report", title="say hello", ' +
        'description="respond with the word hello", waitForCompletion=true, timeoutSeconds=180. ' +
        "Then end your turn.",
      assigneeAgentId: parentId,
    });

    const parentRunRow = await pollRun(
      db,
      // TODO: resolve initial parent run id via issue.executionRunId once API returns it
      issue.id,
      (r) => r.status === "done" || r.status === "failed",
      300_000,
    );
    expect(parentRunRow, "parent run should reach terminal status").not.toBeNull();
    // Assertions on childRun.parent_run_id + costUsd added once parentRunRow.id known.
  }, 360_000);

  // -------------------------------------------------------------------------
  // Test 5 — Timeout characterization. Short timeoutSeconds should yield
  // status="timeout", errorCode="timeout"; child run should still complete
  // independently (not cancelled by the parent's timeout).
  // -------------------------------------------------------------------------
  it.skip("Test 5 — timeout characterization (scaffolded, needs parent-run-id plumbing)", async () => {
    expect(true).toBe(true);
  }, 360_000);

  // -------------------------------------------------------------------------
  // Test 6 — waitForCompletion=false. Tool returns immediately with
  // status="queued", childRunId populated, finalText=null, costUsd=null.
  // -------------------------------------------------------------------------
  it.skip("Test 6 — waitForCompletion=false returns queued (scaffolded)", async () => {
    expect(true).toBe(true);
  }, 120_000);
});
