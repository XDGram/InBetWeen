import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/ai/openAiCompatibleProvider.js";

test("OpenAI-compatible provider maps real provider JSON into runtime events", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://ai.example.test/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            events: [
              { type: "work.activity", message: "Created the landing page structure." },
              {
                type: "artifact.updated",
                artifact: {
                  title: "InBetween Landing Page",
                  content: "<!doctype html><html><body><h1>InBetween</h1></body></html>",
                  metadata: { decisionInfluence: "Initial neutral draft" },
                },
              },
              {
                type: "ai.needs_user",
                prompt: "Minimal editorial or energetic product style?",
                options: [{ id: "minimal", label: "Minimal editorial" }],
              },
            ],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://ai.example.test/v1/",
      apiKey: "test-key",
      model: "test-model",
    });

    const events = [];
    for await (const event of provider.startWork({ session: session() })) {
      events.push(event);
    }

    assert.deepEqual(events.map((event) => event.type), ["work.activity", "artifact.updated", "ai.needs_user"]);
    assert.equal(events[1]?.type, "artifact.updated");
    if (events[1]?.type === "artifact.updated") {
      assert.equal(events[1].artifact.kind, "website");
      assert.equal(events[1].artifact.version, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible provider fails fast without configuration", async () => {
  const provider = new OpenAICompatibleProvider({});
  await assert.rejects(async () => {
    for await (const _event of provider.startWork({ session: session() })) {
      // consume iterator
    }
  }, /requires INBETWEEN_AI_BASE_URL/);
});

test("OpenAI-compatible continuation sends accumulated Shape directions to the model", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ events: [{ type: "work.completed", summary: "Done" }] }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://ai.example.test/v1", apiKey: "key", model: "model" });
    const shapedSession = {
      ...session(),
      directions: [{
        id: "direction_1",
        sessionId: "session_provider_test",
        kind: "visual_style" as const,
        value: "minimal" as const,
        instruction: "Use the unique minimal direction marker.",
        createdAt: "2026-09-14T00:00:01.000Z",
      }],
    };
    const decision = {
      id: "decision_1",
      sessionId: shapedSession.id,
      requestId: "request_1",
      response: "Editorial",
      createdAt: "2026-09-14T00:00:02.000Z",
    };

    for await (const _event of provider.continueWork({ session: shapedSession, decision })) {
      // consume iterator
    }

    assert.match(requestBody, /unique minimal direction marker/);
    assert.match(requestBody, /Editorial/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function session() {
  return {
    id: "session_provider_test",
    task: "Create a landing page for InBetween",
    status: "working" as const,
    activity: [],
    decisions: [],
    directions: [],
    events: [],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
}
