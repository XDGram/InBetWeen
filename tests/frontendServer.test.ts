import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AiContinueContext, AiProvider, AiStartContext } from "../src/ai/provider.js";
import { createFrontendServer } from "../src/frontend/server.js";
import { InMemoryPersistence } from "../src/persistence/inMemoryPersistence.js";
import { WorkRuntime } from "../src/runtime/workRuntime.js";
import type { RuntimeEvent, WorkSession } from "../src/shared/types.js";

test("frontend API shapes in-flight AI work, then completes a later required decision", async (t) => {
  const provider = new GatedLandingPageProvider();
  const persistence = new InMemoryPersistence();
  const runtime = new WorkRuntime({
    aiProvider: provider,
    persistence,
  });
  const server = createFrontendServer({ runtime });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stay in control while AI works/);

  const created = await jsonRequest<WorkSession>(`${baseUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({ task: "Create a landing page for InBetween" }),
  });
  assert.equal(created.status, "idle");

  const streamResponse = await fetch(`${baseUrl}/api/sessions/${created.id}/events`);
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = streamResponse.body!.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  t.after(async () => {
    await reader.cancel();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  await jsonRequest(`${baseUrl}/api/sessions/${created.id}/start`, { method: "POST", body: "{}" });
  streamed = await readUntil(reader, decoder, streamed, '"type":"work.started"');

  const shaped = await jsonRequest<WorkSession>(`${baseUrl}/api/sessions/${created.id}/directions`, {
    method: "POST",
    body: JSON.stringify({ value: "minimal" }),
  });
  assert.equal(shaped.status, "working");
  assert.equal(shaped.directions[0]?.value, "minimal");
  assert.equal(shaped.activity[0]?.metadata?.source, "user");
  provider.releaseInitialWork();

  streamed = await readUntil(reader, decoder, streamed, '"type":"ai.needs_user"');

  const waiting = await jsonRequest<WorkSession>(`${baseUrl}/api/sessions/${created.id}`);
  assert.equal(waiting.status, "needs_user");
  assert.equal(waiting.currentArtifact?.kind, "website");
  assert.equal(waiting.currentArtifact?.version, 1);
  assert.equal(waiting.directions[0]?.value, "minimal");

  await jsonRequest(`${baseUrl}/api/sessions/${created.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({ response: "Use an editorial finish", selectedOptionId: "editorial" }),
  });
  streamed = await readUntil(reader, decoder, streamed, '"type":"work.completed"');

  const completed = await jsonRequest<WorkSession>(`${baseUrl}/api/sessions/${created.id}`);
  assert.equal(completed.id, created.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.currentArtifact?.version, 2);
  assert.match(completed.currentArtifact?.content ?? "", /Minimal/);
  assert.match(completed.currentArtifact?.content ?? "", /editorial finish/);
  assert.equal(completed.decisions[0]?.selectedOptionId, "editorial");
  assert.equal(provider.continuationDirections[0]?.value, "minimal");
  assert.equal((await persistence.listDirections(created.id)).length, 1);
  assert.match(streamed, /user.direction_provided/);
  assert.match(streamed, /artifact.updated/);
  assert.match(streamed, /work.resumed/);

  const terminalDirection = await fetch(`${baseUrl}/api/sessions/${created.id}/directions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "bold" }),
  });
  assert.equal(terminalDirection.status, 409);
});

class GatedLandingPageProvider implements AiProvider {
  continuationDirections: AiContinueContext["session"]["directions"] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  releaseInitialWork(): void {
    this.release();
  }

  async *startWork(context: AiStartContext): AsyncIterable<RuntimeEvent> {
    await this.gate;
    const now = new Date().toISOString();
    yield {
      id: "initial_activity",
      sessionId: context.session.id,
      type: "work.activity",
      createdAt: now,
      activity: { id: "initial_activity_item", sessionId: context.session.id, message: "Created the initial structure.", createdAt: now },
    };
    yield {
      id: "initial_artifact",
      sessionId: context.session.id,
      type: "artifact.updated",
      createdAt: now,
      artifact: {
        id: "landing_page",
        sessionId: context.session.id,
        kind: "website",
        version: 1,
        title: "Initial Landing Page",
        content: "<!doctype html><html><body><h1>Initial draft</h1></body></html>",
        metadata: { taskType: "landing-page", format: "single-file-html" },
        createdAt: now,
        updatedAt: now,
      },
    };
    yield {
      id: "required_decision",
      sessionId: context.session.id,
      type: "ai.needs_user",
      createdAt: now,
      decision: {
        id: "finish_direction",
        sessionId: context.session.id,
        prompt: "Should the final finish be editorial or energetic?",
        options: [{ id: "editorial", label: "Editorial" }, { id: "energetic", label: "Energetic" }],
        required: true,
        createdAt: now,
      },
    };
  }

  async *continueWork(context: AiContinueContext): AsyncIterable<RuntimeEvent> {
    this.continuationDirections = context.session.directions;
    const now = new Date().toISOString();
    const shape = context.session.directions.map((direction) => direction.value).join(", ");
    yield {
      id: "final_artifact",
      sessionId: context.session.id,
      type: "artifact.updated",
      createdAt: now,
      artifact: {
        id: context.session.currentArtifact!.id,
        sessionId: context.session.id,
        kind: "website",
        version: 2,
        title: "Shaped Landing Page",
        content: `<!doctype html><html><body><h1>Shape: ${shape === "minimal" ? "Minimal" : shape}</h1><p>${context.decision.response}</p></body></html>`,
        metadata: { taskType: "landing-page", format: "single-file-html", decisionInfluence: `${shape}; ${context.decision.response}` },
        createdAt: context.session.currentArtifact!.createdAt,
        updatedAt: now,
      },
    };
    yield {
      id: "completed",
      sessionId: context.session.id,
      type: "work.completed",
      createdAt: now,
      completion: { completedAt: now, summary: "Applied the Shape direction and required decision." },
    };
  }
}

async function jsonRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body as T;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initial: string,
  marker: string,
): Promise<string> {
  let content = initial;
  const deadline = Date.now() + 2_000;
  while (!content.includes(marker)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for SSE marker ${marker}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${marker}`)), remaining)),
    ]);
    if (result.done) throw new Error(`SSE ended before ${marker}`);
    content += decoder.decode(result.value, { stream: true });
  }
  return content;
}
