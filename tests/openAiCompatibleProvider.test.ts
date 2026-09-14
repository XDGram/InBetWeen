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

function session() {
  return {
    id: "session_provider_test",
    task: "Create a landing page for InBetween",
    status: "working" as const,
    activity: [],
    decisions: [],
    events: [],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
}
