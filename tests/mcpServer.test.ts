import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SqlitePersistence } from "../src/persistence/sqlitePersistence.js";
import { WorkRuntime } from "../src/runtime/workRuntime.js";
import { INBETWEEN_AGENT_INSTRUCTIONS } from "../src/mcp/agentInstructions.js";
import type { ExternalAgentError } from "../src/shared/externalAgent.js";
import type { WorkSession } from "../src/shared/types.js";

test("MCP stdio adapter drives the external-agent lifecycle through SQLite", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inbetween-mcp-"));
  const databasePath = join(directory, "mcp-lifecycle.sqlite");
  let first: Awaited<ReturnType<typeof connectMcp>> | undefined;
  let second: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    first = await connectMcp(databasePath);
    second = await connectMcp(databasePath);

    const tools = await first.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).filter((name) => name.startsWith("inbetween_")).sort(), [
      "inbetween_complete_work",
      "inbetween_fail_work",
      "inbetween_get_context",
      "inbetween_publish_artifact",
      "inbetween_report_activity",
      "inbetween_request_decision",
      "inbetween_session_create",
      "inbetween_session_start",
      "inbetween_wait_for_human_input",
    ]);

    const prompt = await first.client.getPrompt({ name: "inbetween_agent_instructions" });
    assert.match(prompt.messages[0]?.content.type === "text" ? prompt.messages[0].content.text : "", /Never invent progress/);
    assert.equal(first.client.getInstructions(), INBETWEEN_AGENT_INSTRUCTIONS);

    const created = await callOk(first.client, "inbetween_session_create", {
      sessionId: "mcp_session",
      task: "Create a landing page for InBetween.",
      context: { client: "integration-test" },
      idempotencyKey: "mcp_register_session",
    });
    assert.equal(created.sessionId, "mcp_session");
    assert.equal((created.session as WorkSession).status, "idle");

    const started = await callOk(first.client, "inbetween_session_start", {
      sessionId: created.sessionId,
      eventId: "mcp_started",
      expectedSessionUpdatedAt: created.session.updatedAt,
    });
    assert.equal((started.session as WorkSession).status, "working");

    const duplicate = await callRaw(first.client, "inbetween_report_activity", {
      sessionId: created.sessionId,
      eventId: "mcp_started",
      activity: { message: "Duplicate event should be rejected." },
    });
    assert.equal(duplicate.ok, false);
    assert.equal((duplicate.error as ExternalAgentError).code, "duplicate_event");

    const stale = await callRaw(first.client, "inbetween_report_activity", {
      sessionId: created.sessionId,
      eventId: "mcp_stale_activity",
      expectedSessionUpdatedAt: created.session.updatedAt,
      activity: { message: "This write is based on stale session state." },
    });
    assert.equal(stale.ok, false);
    assert.equal((stale.error as ExternalAgentError).code, "stale_event");

    const activity = await callOk(first.client, "inbetween_report_activity", {
      sessionId: created.sessionId,
      eventId: "mcp_activity",
      expectedSessionUpdatedAt: started.session.updatedAt,
      activity: { message: "Drafted the landing page structure.", metadata: { stage: "structure" } },
    });
    assert.equal(activity.event.type, "work.activity");

    const artifact = await callOk(first.client, "inbetween_publish_artifact", {
      sessionId: created.sessionId,
      eventId: "mcp_artifact_v1",
      expectedSessionUpdatedAt: activity.session.updatedAt,
      expectedArtifactVersion: 0,
      artifact: {
        kind: "website",
        title: "InBetween",
        content: "<!doctype html><html><body><h1>Stay in control while AI works.</h1></body></html>",
        metadata: { taskType: "landing-page", format: "single-file-html" },
      },
    });
    assert.equal(artifact.artifact.version, 1);

    const decision = await callOk(first.client, "inbetween_request_decision", {
      sessionId: created.sessionId,
      eventId: "mcp_needs_user",
      expectedSessionUpdatedAt: artifact.session.updatedAt,
      prompt: "Should the final page feel editorial or energetic?",
      options: [
        { id: "editorial", label: "Editorial" },
        { id: "energetic", label: "Energetic" },
      ],
      required: true,
    });
    assert.equal((decision.session as WorkSession).status, "needs_user");

    const localPersistence = new SqlitePersistence(databasePath);
    const localRuntime = new WorkRuntime({ persistence: localPersistence });
    const observedFromFrontendProcess = await localRuntime.getSession(created.sessionId);
    assert.equal(observedFromFrontendProcess?.status, "needs_user");
    await localRuntime.respondToUser(created.sessionId, "Use editorial.", "editorial");
    localPersistence.close();

    const humanInput = await callOk(first.client, "inbetween_wait_for_human_input", {
      sessionId: created.sessionId,
      afterEventId: decision.event.id,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
    });
    assert.equal(humanInput.timedOut, false);
    assert.deepEqual(humanInput.events.map((event: { type: string }) => event.type), ["user.responded"]);
    assert.equal(humanInput.decisions[0]?.response, "Use editorial.");

    const secondProcessContext = await callOk(second.client, "inbetween_get_context", {
      sessionId: created.sessionId,
      recentEventLimit: 4,
    });
    assert.equal((secondProcessContext.session as WorkSession).status, "working");
    assert.equal((secondProcessContext.session as WorkSession).events.length, 4);
    assert.equal(secondProcessContext.decisions[0]?.selectedOptionId, "editorial");
    assert.equal(secondProcessContext.currentArtifact.version, 1);

    const resumedActivity = await callOk(first.client, "inbetween_report_activity", {
      sessionId: created.sessionId,
      eventId: "mcp_after_human_activity",
      expectedSessionUpdatedAt: secondProcessContext.session.updatedAt,
      activity: { message: "Applied the editorial direction from the human." },
    });
    const completed = await callOk(first.client, "inbetween_complete_work", {
      sessionId: created.sessionId,
      eventId: "mcp_completed",
      expectedSessionUpdatedAt: resumedActivity.session.updatedAt,
      summary: "Completed a first website artifact using human direction.",
    });
    assert.equal((completed.session as WorkSession).status, "completed");

    const finalPersistence = new SqlitePersistence(databasePath);
    const finalSession = await finalPersistence.getSession(created.sessionId);
    assert.equal(finalSession?.status, "completed");
    assert.deepEqual((await finalPersistence.listEvents(created.sessionId)).map((event) => event.type), [
      "work.started",
      "work.activity",
      "artifact.updated",
      "ai.needs_user",
      "user.responded",
      "work.resumed",
      "work.activity",
      "work.completed",
    ]);
    finalPersistence.close();
  } finally {
    await second?.close();
    await first?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP wait_for_human_input reports timeout without blocking indefinitely", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inbetween-mcp-"));
  const databasePath = join(directory, "mcp-timeout.sqlite");
  let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    mcp = await connectMcp(databasePath);
    const created = await callOk(mcp.client, "inbetween_session_create", {
      sessionId: "mcp_timeout_session",
      task: "Wait for user input.",
      idempotencyKey: "mcp_timeout_register",
    });
    const waited = await callOk(mcp.client, "inbetween_wait_for_human_input", {
      sessionId: created.sessionId,
      timeoutMs: 100,
      pollIntervalMs: 50,
    });
    assert.equal(waited.timedOut, true);
    assert.equal(waited.events.length, 0);
  } finally {
    await mcp?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function connectMcp(databasePath: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp/run-server.js"],
    cwd: process.cwd(),
    env: {
      ...stringEnv(process.env),
      INBETWEEN_PERSISTENCE: "sqlite",
      INBETWEEN_SQLITE_PATH: databasePath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "inbetween-mcp-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      const pid = transport.pid;
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          // Already exited.
        }
      }
      try {
        await Promise.race([
          transport.close(),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
      } catch {
        // A failed test may leave the stdio child mid-request; kill it below.
      }
    },
  };
}

async function callOk(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await callRaw(client, name, args);
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function callRaw(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }) as CallToolResult;
  const structured = result.structuredContent as { ok: boolean; value?: unknown; error?: unknown } | undefined;
  assert.ok(structured, `Tool ${name} did not return structuredContent`);
  return structured;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
