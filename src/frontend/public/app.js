const elements = {
  taskForm: document.querySelector("#task-form"),
  taskInput: document.querySelector("#task-input"),
  startButton: document.querySelector("#start-button"),
  sessionStatus: document.querySelector("#session-status"),
  connection: document.querySelector("#connection"),
  connectionLabel: document.querySelector("#connection-label"),
  decisionSection: document.querySelector("#decision-section"),
  decisionPrompt: document.querySelector("#decision-prompt"),
  decisionForm: document.querySelector("#decision-form"),
  decisionOptions: document.querySelector("#decision-options"),
  decisionResponse: document.querySelector("#decision-response"),
  decisionButton: document.querySelector("#decision-button"),
  failureSection: document.querySelector("#failure-section"),
  failureMessage: document.querySelector("#failure-message"),
  restartButton: document.querySelector("#restart-button"),
  artifactEmpty: document.querySelector("#artifact-empty"),
  artifactPreview: document.querySelector("#artifact-preview"),
  artifactTitle: document.querySelector("#artifact-title"),
  artifactVersion: document.querySelector("#artifact-version"),
  nowWorking: document.querySelector("#now-working"),
  currentActivity: document.querySelector("#current-activity"),
  activityList: document.querySelector("#activity-list"),
  completion: document.querySelector("#completion"),
  completionSummary: document.querySelector("#completion-summary"),
  decisionSummary: document.querySelector("#decision-summary"),
  toast: document.querySelector("#toast"),
};

let session;
let eventSource;
let selectedOptionId;
let toastTimeout;

elements.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = elements.taskInput.value.trim();
  if (!task) return;

  setCommandBusy(true, "Starting...");
  try {
    session = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ task }),
    });
    renderSession();
    connectToSession(session.id);
    await request(`/api/sessions/${encodeURIComponent(session.id)}/start`, { method: "POST", body: "{}" });
  } catch (error) {
    showToast(error.message);
    setCommandBusy(false);
  }
});

elements.decisionOptions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-option-id]");
  if (!button) return;
  selectedOptionId = button.dataset.optionId;
  for (const option of elements.decisionOptions.querySelectorAll("button")) {
    option.setAttribute("aria-pressed", String(option === button));
  }
});

elements.decisionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session || session.status !== "needs_user") return;

  const selected = session.pendingUserDecision?.options?.find((option) => option.id === selectedOptionId);
  const writtenResponse = elements.decisionResponse.value.trim();
  const response = writtenResponse || selected?.label;
  if (!response) {
    showToast("Choose a direction or add your own context.");
    return;
  }

  elements.decisionButton.disabled = true;
  elements.decisionButton.firstElementChild.textContent = "Resuming...";
  try {
    await request(`/api/sessions/${encodeURIComponent(session.id)}/decisions`, {
      method: "POST",
      body: JSON.stringify({ response, selectedOptionId }),
    });
  } catch (error) {
    showToast(error.message);
    elements.decisionButton.disabled = false;
    elements.decisionButton.firstElementChild.textContent = "Use this direction";
  }
});

elements.restartButton.addEventListener("click", () => {
  disconnect();
  session = undefined;
  selectedOptionId = undefined;
  elements.taskInput.disabled = false;
  elements.taskInput.focus();
  renderSession();
});

function connectToSession(sessionId) {
  disconnect();
  eventSource = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  setConnection(true, "Live");

  eventSource.addEventListener("session", (event) => {
    session = JSON.parse(event.data);
    renderSession();
  });

  eventSource.addEventListener("runtime", (event) => {
    const envelope = JSON.parse(event.data);
    session = envelope.session;
    renderSession();
  });

  eventSource.onerror = async () => {
    setConnection(false, "Reconnecting");
    try {
      session = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
      renderSession();
    } catch {
      setConnection(false, "Disconnected");
    }
  };
}

function disconnect() {
  eventSource?.close();
  eventSource = undefined;
  setConnection(false, "Ready");
}

function renderSession() {
  const status = session?.status ?? "idle";
  document.body.dataset.status = status;
  elements.sessionStatus.textContent = status.replace("_", " ");
  elements.taskInput.disabled = Boolean(session);
  elements.startButton.hidden = Boolean(session);
  setCommandBusy(false);

  renderDecision(status);
  renderArtifact();
  renderActivity(status);
  renderCompletion(status);
  renderFailure(status);
}

function renderDecision(status) {
  const request = session?.pendingUserDecision;
  elements.decisionSection.hidden = status !== "needs_user" || !request;
  if (!request) return;

  elements.decisionPrompt.textContent = request.prompt;
  elements.decisionOptions.replaceChildren(...(request.options ?? []).map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    button.dataset.optionId = option.id;
    button.setAttribute("aria-pressed", String(option.id === selectedOptionId));
    const label = document.createElement("strong");
    label.textContent = option.label;
    button.append(label);
    if (option.description) {
      const description = document.createElement("small");
      description.textContent = option.description;
      button.append(description);
    }
    return button;
  }));
  elements.decisionButton.disabled = false;
  elements.decisionButton.firstElementChild.textContent = "Use this direction";
}

function renderArtifact() {
  const artifact = session?.currentArtifact;
  const isWebsite = artifact?.kind === "website";
  elements.artifactEmpty.hidden = Boolean(isWebsite);
  elements.artifactPreview.hidden = !isWebsite;
  elements.artifactTitle.textContent = artifact?.title ?? "No artifact yet";
  elements.artifactVersion.textContent = `v${artifact?.version ?? 0}`;
  if (isWebsite && elements.artifactPreview.srcdoc !== artifact.content) {
    elements.artifactPreview.srcdoc = artifact.content;
  }
}

function renderActivity(status) {
  const events = session?.events ?? [];
  elements.activityList.replaceChildren(...(events.length ? events.map(renderEvent) : [emptyActivity()]));

  const latestActivity = [...(session?.activity ?? [])].at(-1);
  elements.nowWorking.hidden = status !== "working";
  elements.currentActivity.textContent = latestActivity?.message ?? "AI work has started.";
}

function renderEvent(event) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.dateTime = event.createdAt;
  time.textContent = new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const message = document.createElement("p");
  message.textContent = eventMessage(event);
  item.className = `event-${event.type.split(".").at(-1)}`;
  item.append(time, message);
  return item;
}

function eventMessage(event) {
  switch (event.type) {
    case "work.started": return "Work started";
    case "work.activity": return event.activity.message;
    case "artifact.updated": return `${event.artifact.title ?? "Artifact"} updated to version ${event.artifact.version}`;
    case "ai.needs_user": return `Your direction is needed: ${event.decision.prompt}`;
    case "user.responded": return `Decision received: ${event.decision.response}`;
    case "work.resumed": return "Work resumed with your decision";
    case "work.completed": return event.completion.summary ?? "Work completed";
    case "work.failed": return `Work failed: ${event.error.message}`;
    default: return "Runtime event received";
  }
}

function emptyActivity() {
  const item = document.createElement("li");
  item.className = "activity-empty";
  item.textContent = "Activity will appear when work begins.";
  return item;
}

function renderCompletion(status) {
  elements.completion.hidden = status !== "completed";
  if (status !== "completed") return;

  elements.completionSummary.textContent = session.completion?.summary ?? "The AI completed the landing page artifact.";
  const decisions = session.decisions ?? [];
  elements.decisionSummary.replaceChildren();
  if (decisions.length) {
    const summary = document.createElement("p");
    const label = document.createElement("strong");
    label.textContent = "Your influence: ";
    summary.append(label, document.createTextNode(decisions.map((decision) => decision.response).join("; ")));
    elements.decisionSummary.append(summary);
  }
}

function renderFailure(status) {
  elements.failureSection.hidden = status !== "failed";
  if (status === "failed") {
    elements.failureMessage.textContent = session.error?.message ?? "The provider could not complete this session.";
  }
}

function setCommandBusy(busy, label = "Start AI work") {
  elements.startButton.disabled = busy;
  elements.startButton.firstElementChild.textContent = label;
}

function setConnection(connected, label) {
  elements.connection.dataset.connected = String(connected);
  elements.connectionLabel.textContent = label;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed with HTTP ${response.status}`);
  return body;
}

function showToast(message) {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimeout = setTimeout(() => { elements.toast.hidden = true; }, 5000);
}

renderSession();
