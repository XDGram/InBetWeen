import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type {
  ExternalAgentError,
  ExternalAgentResult,
  ExternalAgentRuntimePort,
  GetHumanInputSuccess,
} from "../shared/externalAgent.js";
import type { ArtifactKind, UserDecisionOption, WorkSession } from "../shared/types.js";
import { INBETWEEN_AGENT_INSTRUCTIONS } from "./agentInstructions.js";

export interface InBetweenMcpRuntime extends ExternalAgentRuntimePort {
  getSession(sessionId: string): Promise<WorkSession | undefined>;
}

export interface InBetweenMcpServerOptions {
  runtime: InBetweenMcpRuntime;
  recentEventLimit?: number;
}

const DEFAULT_RECENT_EVENT_LIMIT = 25;
const MAX_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

const artifactKinds = ["text", "json", "markdown", "website"] as const satisfies ArtifactKind[];

const stringRecordSchema = z.record(z.string(), z.unknown());

const baseEventSchema = {
  sessionId: z.string().min(1),
  eventId: z.string().min(1),
  expectedSessionUpdatedAt: z.string().optional(),
};

const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

type McpStructuredResult = {
  ok: true;
  value: unknown;
} | {
  ok: false;
  error: ExternalAgentError;
};

export function createInBetweenMcpServer(options: InBetweenMcpServerOptions): McpServer {
  const recentEventLimit = options.recentEventLimit ?? DEFAULT_RECENT_EVENT_LIMIT;
  const server = new McpServer({
    name: "inbetween",
    version: "0.1.0",
  }, {
    instructions: INBETWEEN_AGENT_INSTRUCTIONS,
    capabilities: {
      tools: {},
      prompts: {},
    },
  });

  server.registerPrompt("inbetween_agent_instructions", {
    title: "InBetween agent instructions",
    description: "How an external AI agent should use InBetween as the human interaction layer.",
  }, () => ({
    description: "Operational guidance for external agents connected to InBetween.",
    messages: [{
      role: "user",
      content: { type: "text", text: INBETWEEN_AGENT_INSTRUCTIONS },
    }],
  }));

  server.registerTool("inbetween_session_create", {
    title: "Create InBetween session",
    description: "Register a new InBetween work session for a real user task.",
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      task: z.string().min(1),
      context: stringRecordSchema.optional(),
      idempotencyKey: z.string().min(1),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toToolResult(await options.runtime.registerSession(input)));

  server.registerTool("inbetween_session_start", {
    title: "Start InBetween work",
    description: "Mark a registered session as actively working.",
    inputSchema: baseEventSchema,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toToolResult(await options.runtime.startWork(input)));

  server.registerTool("inbetween_report_activity", {
    title: "Report work activity",
    description: "Record meaningful external-agent work activity for the human to see.",
    inputSchema: {
      ...baseEventSchema,
      activity: z.object({
        message: z.string().min(1),
        metadata: stringRecordSchema.optional(),
      }),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toToolResult(await options.runtime.reportActivity(input)));

  server.registerTool("inbetween_publish_artifact", {
    title: "Publish artifact",
    description: "Publish or update the current artifact produced by the external agent.",
    inputSchema: {
      ...baseEventSchema,
      artifactId: z.string().min(1).optional(),
      expectedArtifactVersion: z.number().int().min(0),
      artifact: z.object({
        kind: z.enum(artifactKinds),
        title: z.string().optional(),
        content: z.string().min(1),
        metadata: stringRecordSchema.optional(),
      }),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toToolResult(await options.runtime.publishArtifact(input)));

  server.registerTool("inbetween_request_decision", {
    title: "Request human decision",
    description: "Ask the human for a required decision and transition the session to needs_user.",
    inputSchema: {
      ...baseEventSchema,
      decisionId: z.string().min(1).optional(),
      prompt: z.string().min(1),
      options: z.array(decisionOptionSchema).optional(),
      required: z.literal(true),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toToolResult(await options.runtime.requestDecision({
    ...input,
    options: input.options as UserDecisionOption[] | undefined,
  })));

  server.registerTool("inbetween_wait_for_human_input", {
    title: "Wait for human input",
    description: "Poll briefly for human decisions or Shape directions without holding a long-lived request.",
    inputSchema: {
      sessionId: z.string().min(1),
      afterEventId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(0).max(MAX_WAIT_TIMEOUT_MS).optional(),
      pollIntervalMs: z.number().int().min(50).max(2_000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const timeoutMs = input.timeoutMs ?? 0;
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    let last: ExternalAgentResult<GetHumanInputSuccess>;

    do {
      last = await options.runtime.getHumanInput({
        sessionId: input.sessionId,
        afterEventId: input.afterEventId,
        limit: input.limit,
      });
      if (!last.ok) return toToolResult(last);
      if (last.value.events.length > 0 || isTerminal(last.value.session.status)) {
        return toToolResult({
          ok: true,
          value: compactHumanInput(last.value, input.limit ?? recentEventLimit, false, Date.now() - startedAt),
        });
      }
      if (timeoutMs === 0) {
        return toToolResult({
          ok: true,
          value: compactHumanInput(last.value, input.limit ?? recentEventLimit, false, 0),
        });
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
    } while (Date.now() - startedAt < timeoutMs);

    return toToolResult({
      ok: true,
      value: compactHumanInput(last!.value, input.limit ?? recentEventLimit, true, Date.now() - startedAt),
    });
  });

  server.registerTool("inbetween_get_context", {
    title: "Get session context",
    description: "Read bounded current session context relevant to external-agent continuation.",
    inputSchema: {
      sessionId: z.string().min(1),
      recentEventLimit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const session = await options.runtime.getSession(input.sessionId);
    if (!session) {
      return toToolResult({
        ok: false,
        error: {
          code: "session_not_found",
          message: `Session ${input.sessionId} does not exist.`,
          retryable: false,
          sessionId: input.sessionId,
        },
      });
    }
    const limit = input.recentEventLimit ?? recentEventLimit;
    return toToolResult({
      ok: true,
      value: {
        session: compactSession(session, limit),
        currentArtifact: session.currentArtifact
          ? {
              id: session.currentArtifact.id,
              kind: session.currentArtifact.kind,
              title: session.currentArtifact.title,
              version: session.currentArtifact.version,
              metadata: session.currentArtifact.metadata,
              updatedAt: session.currentArtifact.updatedAt,
            }
          : undefined,
        pendingDecision: session.pendingUserDecision,
        directions: session.directions,
        decisions: session.decisions,
        recentEvents: session.events.slice(-limit),
        latestEventId: session.events.at(-1)?.id,
      },
    });
  });

  server.registerTool("inbetween_complete_work", {
    title: "Complete work",
    description: "Mark the session complete after the external agent has finished real work.",
    inputSchema: {
      ...baseEventSchema,
      summary: z.string().optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toToolResult(await options.runtime.completeWork(input)));

  server.registerTool("inbetween_fail_work", {
    title: "Fail work",
    description: "Mark the session failed when the external agent cannot continue.",
    inputSchema: {
      ...baseEventSchema,
      error: z.object({
        message: z.string().min(1),
        code: z.string().optional(),
        cause: z.unknown().optional(),
      }),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toToolResult(await options.runtime.failWork(input)));

  return server;
}

function toToolResult<T>(result: ExternalAgentResult<T> | { ok: true; value: T }) {
  const structuredContent: McpStructuredResult = result.ok
    ? { ok: true, value: result.value }
    : { ok: false, error: result.error };
  return {
    structuredContent,
    isError: !result.ok,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function isTerminal(status: WorkSession["status"]): boolean {
  return status === "completed" || status === "failed";
}

function compactHumanInput(input: GetHumanInputSuccess, eventLimit: number, timedOut: boolean, waitedMs: number) {
  return {
    ...input,
    session: compactSession(input.session, eventLimit),
    timedOut,
    waitedMs,
  };
}

function compactSession(session: WorkSession, eventLimit: number): WorkSession {
  return { ...session, events: session.events.slice(-eventLimit) };
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
