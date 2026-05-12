import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SPO-84 recovery tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("SPO-84 stranded recovery guards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spo-84-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: null,
      source: "agent_jwt",
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, issuePrefix };
  }

  async function seedAgent(input: {
    companyId: string;
    adapterType?: string;
    status?: string;
    name?: string;
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name ?? "Agent",
      role: "executive",
      status: input.status ?? "idle",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("skips stranded recovery when the issue has a pending wake_assignee interaction", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, name: "Sebastian Gate", adapterType: "process", status: "error" });
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: assigneeAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      runId,
      error: "adapter_failed - Process adapter missing command",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, retryReason: "assignment_recovery" },
      finishedAt: new Date(),
      errorCode: "adapter_failed",
      error: "Process adapter missing command",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Decide on rollout window",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { questions: [] },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const source = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(source?.status).toBe("in_progress");
  });

  it("skips stranded recovery when the assignee is a process-adapter human-owner placeholder in error state", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, name: "Sebastian Brunk", adapterType: "process", status: "error" });
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: assigneeAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      runId,
      error: "adapter_failed - Process adapter missing command",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, retryReason: "assignment_recovery" },
      finishedAt: new Date(),
      errorCode: "adapter_failed",
      error: "Process adapter missing command",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Human-owned decision",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("admin recovery-takeover reassigns the source, clears the recovery blocker, and audits", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const brokenAssigneeId = await seedAgent({ companyId, name: "Sebastian Brunk", adapterType: "process", status: "error" });
    const recoveryOwnerId = await seedAgent({ companyId, name: "CEO" });

    const sourceId = randomUUID();
    const recoveryId = randomUUID();
    await db.insert(issues).values([
      {
        id: sourceId,
        companyId,
        title: "Stalled source",
        status: "blocked",
        priority: "high",
        assigneeAgentId: brokenAssigneeId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: recoveryId,
        companyId,
        title: "Recover stalled issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: recoveryOwnerId,
        originKind: "stranded_issue_recovery",
        originId: sourceId,
        parentId: sourceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: recoveryId,
      relatedIssueId: sourceId,
      type: "blocks",
    });

    const res = await request(createApp(agentActor(companyId, recoveryOwnerId)))
      .post(`/api/issues/${sourceId}/admin/recovery-takeover`)
      .send({ recoveryIssueId: recoveryId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue.assigneeAgentId).toBe(recoveryOwnerId);
    expect(res.body.issue.checkoutRunId).toBeNull();
    expect(res.body.issue.status).toBe("todo");
    expect(res.body.previous).toMatchObject({
      assigneeAgentId: brokenAssigneeId,
      status: "blocked",
    });

    const blockerRows = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRows).toHaveLength(0);

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceId));
    expect(audit.some((row) => row.action === "issue.admin_recovery_takeover")).toBe(true);
  });

  it("rejects recovery-takeover from an agent that is not the recovery owner", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const brokenAssigneeId = await seedAgent({ companyId, name: "Sebastian Brunk", adapterType: "process", status: "error" });
    const recoveryOwnerId = await seedAgent({ companyId, name: "CEO" });
    const intruderId = await seedAgent({ companyId, name: "Intruder" });

    const sourceId = randomUUID();
    const recoveryId = randomUUID();
    await db.insert(issues).values([
      {
        id: sourceId,
        companyId,
        title: "Stalled source",
        status: "blocked",
        priority: "high",
        assigneeAgentId: brokenAssigneeId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: recoveryId,
        companyId,
        title: "Recover stalled issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: recoveryOwnerId,
        originKind: "stranded_issue_recovery",
        originId: sourceId,
        parentId: sourceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: recoveryId,
      relatedIssueId: sourceId,
      type: "blocks",
    });

    const res = await request(createApp(agentActor(companyId, intruderId)))
      .post(`/api/issues/${sourceId}/admin/recovery-takeover`)
      .send({ recoveryIssueId: recoveryId });

    expect(res.status).toBe(403);
  });

  it("board recovery-takeover succeeds with an explicit newAssigneeAgentId", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const brokenAssigneeId = await seedAgent({ companyId, name: "Sebastian Brunk", adapterType: "process", status: "error" });
    const recoveryOwnerId = await seedAgent({ companyId, name: "CEO" });
    const newOwnerId = await seedAgent({ companyId, name: "Manager" });

    const sourceId = randomUUID();
    const recoveryId = randomUUID();
    await db.insert(issues).values([
      {
        id: sourceId,
        companyId,
        title: "Stalled source",
        status: "blocked",
        priority: "high",
        assigneeAgentId: brokenAssigneeId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: recoveryId,
        companyId,
        title: "Recover stalled issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: recoveryOwnerId,
        originKind: "stranded_issue_recovery",
        originId: sourceId,
        parentId: sourceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: recoveryId,
      relatedIssueId: sourceId,
      type: "blocks",
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${sourceId}/admin/recovery-takeover`)
      .send({ recoveryIssueId: recoveryId, newAssigneeAgentId: newOwnerId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue.assigneeAgentId).toBe(newOwnerId);
  });

  it("suppresses re-creation of a stranded recovery within the 24h cooldown after a closure", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, name: "CodexCoder" });
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: assigneeAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assignment_recovery",
      payload: { issueId },
      status: "failed",
      runId,
      error: "process_lost",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, retryReason: "assignment_recovery" },
      finishedAt: new Date(),
      errorCode: "process_lost",
      error: "process lost mid-run",
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Stranded source",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
        checkoutRunId: null,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Recover Stranded source (prior)",
        status: "done",
        priority: "medium",
        originKind: "stranded_issue_recovery",
        originId: issueId,
        parentId: issueId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.dispatchRequeued).toBe(0);

    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
        ),
      );
    expect(openRecoveries.filter((r) => r.status !== "done" && r.status !== "cancelled")).toHaveLength(0);
  });

  it("reaper cancels open stranded_issue_recovery issues when source matches new exclusion criteria", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const brokenAssigneeId = await seedAgent({ companyId, name: "Sebastian Brunk", adapterType: "process", status: "error" });
    const recoveryOwnerId = await seedAgent({ companyId, name: "CEO" });

    const sourceId = randomUUID();
    const recoveryId = randomUUID();
    await db.insert(issues).values([
      {
        id: sourceId,
        companyId,
        title: "Human-owner source",
        status: "blocked",
        priority: "high",
        assigneeAgentId: brokenAssigneeId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: recoveryId,
        companyId,
        title: "Recover Human-owner source",
        status: "todo",
        priority: "high",
        assigneeAgentId: recoveryOwnerId,
        originKind: "stranded_issue_recovery",
        originId: sourceId,
        parentId: sourceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: recoveryId,
      relatedIssueId: sourceId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.reapedFalsePositiveRecoveries).toBe(1);
    expect(result.reapedRecoveryBlockerRelationsRemoved).toBe(1);

    const reaped = await db.select().from(issues).where(eq(issues.id, recoveryId)).then((rows) => rows[0]);
    expect(reaped?.status).toBe("cancelled");

    const remainingBlockers = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(remainingBlockers).toHaveLength(0);

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, recoveryId));
    expect(audit.some((row) => row.action === "issue.stranded_recovery_reaped")).toBe(true);
  });

  it("reaper leaves recovery alone when source no longer matches exclusion criteria", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const healthyAssigneeId = await seedAgent({ companyId, name: "CodexCoder" });
    const recoveryOwnerId = await seedAgent({ companyId, name: "CEO" });

    const sourceId = randomUUID();
    const recoveryId = randomUUID();
    await db.insert(issues).values([
      {
        id: sourceId,
        companyId,
        title: "Healthy source",
        status: "blocked",
        priority: "high",
        assigneeAgentId: healthyAssigneeId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: recoveryId,
        companyId,
        title: "Recover healthy source",
        status: "todo",
        priority: "high",
        assigneeAgentId: recoveryOwnerId,
        originKind: "stranded_issue_recovery",
        originId: sourceId,
        parentId: sourceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: recoveryId,
      relatedIssueId: sourceId,
      type: "blocks",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.reapedFalsePositiveRecoveries).toBe(0);
    const reaped = await db.select().from(issues).where(eq(issues.id, recoveryId)).then((rows) => rows[0]);
    expect(reaped?.status).toBe("todo");
  });
});
