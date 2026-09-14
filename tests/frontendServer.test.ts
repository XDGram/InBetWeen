import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createFrontendServer } from "../src/frontend/server.js";
import { InMemoryPersistence } from "../src/persistence/inMemoryPersistence.js";
import { WorkRuntime } from "../src/runtime/workRuntime.js";
import type { WorkSession } from "../src/shared/types.js";
import { ScriptedLifecycleProvider } from "./fixtures/scriptedLifecycleProvider.js";

test("frontend API streams the real decision and resume lifecycle for one session", async (t) => {
  const runtime = new WorkRuntime({
    aiProvider: new ScriptedLifecycleProvider(),
    persistence: new InMemoryPersistence(),
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
  streamed = await readUntil(reader, decoder, streamed, '"type":"ai.needs_user"');

  const waiting = await jsonRequest<WorkSession>(`${baseUrl}/api/sessions/${created.id}`);
  assert.equal(waiting.status, "needs_user");
  assert.equal(waiting.currentArtifact?.kind, "website");
  assert.equal(waiting.currentArtifact?.version, 1);

  await jsonRequest(`${baseUrl}/api/sessions/${created.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({ response: "Keep it concise", selectedOptionId: "concise" }),
  });
  streamed = await readUntil(reader, decoder, streamed, '"type":"work.completed"');

  const completed = await jsonRequest<WorkSession>(`${baseUrl}/api/sessions/${created.id}`);
  assert.equal(completed.id, created.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.currentArtifact?.version, 2);
  assert.match(completed.currentArtifact?.content ?? "", /Keep it concise/);
  assert.equal(completed.decisions[0]?.selectedOptionId, "concise");
  assert.match(streamed, /artifact.updated/);
  assert.match(streamed, /work.resumed/);
});

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
