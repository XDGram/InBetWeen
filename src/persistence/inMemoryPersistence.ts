import type { Artifact, RuntimeEvent, UserDecision, UserDirection, WorkSession } from "../shared/types.js";
import type { PersistenceAdapter } from "./persistence.js";

export class InMemoryPersistence implements PersistenceAdapter {
  private readonly sessions = new Map<string, WorkSession>();
  private readonly events: RuntimeEvent[] = [];
  private readonly artifacts = new Map<string, Artifact>();
  private readonly decisions: UserDecision[] = [];
  private readonly directions: UserDirection[] = [];

  async saveSession(session: WorkSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async getSession(sessionId: string): Promise<WorkSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async appendEvent(event: RuntimeEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async listEvents(sessionId: string): Promise<RuntimeEvent[]> {
    return this.events.filter((event) => event.sessionId === sessionId).map((event) => structuredClone(event));
  }

  async saveArtifact(artifact: Artifact): Promise<void> {
    this.artifacts.set(artifact.id, structuredClone(artifact));
  }

  async getArtifact(artifactId: string): Promise<Artifact | undefined> {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? structuredClone(artifact) : undefined;
  }

  async listArtifacts(sessionId: string): Promise<Artifact[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.sessionId === sessionId)
      .map((artifact) => structuredClone(artifact));
  }

  async saveDecision(decision: UserDecision): Promise<void> {
    this.decisions.push(structuredClone(decision));
  }

  async listDecisions(sessionId: string): Promise<UserDecision[]> {
    return this.decisions.filter((decision) => decision.sessionId === sessionId).map((decision) => structuredClone(decision));
  }

  async saveDirection(direction: UserDirection): Promise<void> {
    this.directions.push(structuredClone(direction));
  }

  async listDirections(sessionId: string): Promise<UserDirection[]> {
    return this.directions
      .filter((direction) => direction.sessionId === sessionId)
      .map((direction) => structuredClone(direction));
  }
}
