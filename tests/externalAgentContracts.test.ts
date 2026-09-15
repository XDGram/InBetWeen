import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompleteWorkInput,
  ExternalAgentRuntimePort,
  FailWorkInput,
  GetHumanInputInput,
  PublishArtifactInput,
  RegisterSessionInput,
  ReportActivityInput,
  RequestDecisionInput,
  StartWorkInput,
} from "../src/shared/externalAgent.js";

test("external-agent write contracts carry session and idempotency fields", () => {
  const common = {
    sessionId: "session_1",
    eventId: "agent_event_1",
    expectedSessionUpdatedAt: "2026-09-15T00:00:00.000Z",
  };

  const start = { ...common } satisfies StartWorkInput;
  const activity = {
    ...common,
    activity: { message: "Outlined the landing page structure.", metadata: { stage: "planning" } },
  } satisfies ReportActivityInput;
  const artifact = {
    ...common,
    expectedArtifactVersion: 0,
    artifact: { kind: "website", content: "<!doctype html><title>InBetween</title>" },
  } satisfies PublishArtifactInput;
  const decision = {
    ...common,
    prompt: "Which visual direction should I use?",
    required: true,
    options: [{ id: "minimal", label: "Minimal" }],
  } satisfies RequestDecisionInput;
  const complete = { ...common, summary: "Landing page completed." } satisfies CompleteWorkInput;
  const fail = { ...common, error: { message: "Unable to continue.", code: "AGENT_FAILURE" } } satisfies FailWorkInput;

  assert.equal(start.sessionId, "session_1");
  assert.equal(activity.eventId, "agent_event_1");
  assert.equal(artifact.expectedArtifactVersion, 0);
  assert.equal(decision.required, true);
  assert.equal(complete.summary, "Landing page completed.");
  assert.equal(fail.error.code, "AGENT_FAILURE");
});

test("registration and human-input contracts remain protocol-neutral", () => {
  const registration = {
    idempotencyKey: "registration_1",
    task: "Create a landing page for InBetween.",
    context: { audience: "product teams" },
  } satisfies RegisterSessionInput;
  const humanInput = {
    sessionId: "session_1",
    afterEventId: "agent_event_1",
    limit: 25,
  } satisfies GetHumanInputInput;

  assert.equal(registration.context.audience, "product teams");
  assert.equal(humanInput.afterEventId, "agent_event_1");
});

test("ExternalAgentRuntimePort exposes only the eight Phase 1 operations", () => {
  type ExpectedMethods =
    | "registerSession"
    | "startWork"
    | "reportActivity"
    | "publishArtifact"
    | "requestDecision"
    | "getHumanInput"
    | "completeWork"
    | "failWork";
  type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
  type Assert<Condition extends true> = Condition;
  const exactMethodSet: Assert<Equal<keyof ExternalAgentRuntimePort, ExpectedMethods>> = true;
  type MethodNames = keyof ExternalAgentRuntimePort;
  const methods: MethodNames[] = [
    "registerSession",
    "startWork",
    "reportActivity",
    "publishArtifact",
    "requestDecision",
    "getHumanInput",
    "completeWork",
    "failWork",
  ];

  assert.equal(exactMethodSet, true);
  assert.deepEqual(methods, [
    "registerSession",
    "startWork",
    "reportActivity",
    "publishArtifact",
    "requestDecision",
    "getHumanInput",
    "completeWork",
    "failWork",
  ]);
});
