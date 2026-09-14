import type { Artifact, RuntimeEvent, UserDecision, WorkSession } from "../shared/types.js";

export interface WorkSessionStore {
  saveSession(session: WorkSession): Promise<void>;
  getSession(sessionId: string): Promise<WorkSession | undefined>;
}

export interface RuntimeEventStore {
  appendEvent(event: RuntimeEvent): Promise<void>;
  listEvents(sessionId: string): Promise<RuntimeEvent[]>;
}

export interface ArtifactStore {
  saveArtifact(artifact: Artifact): Promise<void>;
  getArtifact(artifactId: string): Promise<Artifact | undefined>;
  listArtifacts(sessionId: string): Promise<Artifact[]>;
}

export interface UserDecisionStore {
  saveDecision(decision: UserDecision): Promise<void>;
  listDecisions(sessionId: string): Promise<UserDecision[]>;
}

export interface PersistenceAdapter
  extends WorkSessionStore,
    RuntimeEventStore,
    ArtifactStore,
    UserDecisionStore {}
