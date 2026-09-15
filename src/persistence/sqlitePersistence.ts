import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Artifact, RuntimeEvent, UserDecision, UserDirection, WorkSession } from "../shared/types.js";
import type { PersistenceAdapter, RuntimeEventCommit } from "./persistence.js";

interface PayloadRow {
  payload: string;
}

interface SessionVersionRow extends PayloadRow {
  updated_at: string;
}

export class SqlitePersistence implements PersistenceAdapter {
  private readonly database: DatabaseSync;

  constructor(readonly databasePath: string) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.database = new DatabaseSync(absolutePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.initializeSchema();
  }

  close(): void {
    this.database.close();
  }

  async saveSession(session: WorkSession): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(session.id)) {
        throw new Error(`Session ${session.id} already exists`);
      }
      this.database.prepare(`
        INSERT INTO sessions (id, updated_at, payload) VALUES (?, ?, ?)
      `).run(session.id, session.updatedAt, serialize(session));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<WorkSession | undefined> {
    return readPayload<WorkSession>(this.database.prepare(
      "SELECT payload FROM sessions WHERE id = ?",
    ).get(sessionId));
  }

  async appendEvent(event: RuntimeEvent): Promise<void> {
    this.database.prepare(`
      INSERT INTO runtime_events (id, session_id, created_at, payload)
      VALUES (?, ?, ?, ?)
    `).run(event.id, event.sessionId, event.createdAt, serialize(event));
  }

  async listEvents(sessionId: string): Promise<RuntimeEvent[]> {
    return this.database.prepare(`
      SELECT payload FROM runtime_events WHERE session_id = ? ORDER BY sequence ASC
    `).all(sessionId).map((row) => parsePayload<RuntimeEvent>(row));
  }

  async commitRuntimeEvent({ previousSession, nextSession, event }: RuntimeEventCommit): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(
        "SELECT updated_at, payload FROM sessions WHERE id = ?",
      ).get(previousSession.id) as SessionVersionRow | undefined;
      if (!current || current.updated_at !== previousSession.updatedAt) {
        throw new Error(`Persistence conflict for session ${previousSession.id}`);
      }
      if (this.database.prepare("SELECT 1 FROM runtime_events WHERE id = ?").get(event.id)) {
        throw new Error(`Duplicate runtime event id: ${event.id}`);
      }

      this.database.prepare(`
        INSERT INTO runtime_events (id, session_id, created_at, payload)
        VALUES (?, ?, ?, ?)
      `).run(event.id, event.sessionId, event.createdAt, serialize(event));

      if (event.type === "artifact.updated") this.insertArtifactVersion(event.artifact);
      if (event.type === "user.responded") this.insertDecision(event.decision);
      if (event.type === "user.direction_provided") this.insertDirection(event.direction);

      const updated = this.database.prepare(`
        UPDATE sessions SET updated_at = ?, payload = ? WHERE id = ? AND updated_at = ?
      `).run(nextSession.updatedAt, serialize(nextSession), nextSession.id, previousSession.updatedAt);
      if (updated.changes !== 1) {
        throw new Error(`Persistence conflict for session ${previousSession.id}`);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async saveArtifact(artifact: Artifact): Promise<void> {
    this.database.prepare(`
      INSERT INTO artifacts (artifact_id, version, session_id, updated_at, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id, version) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `).run(artifact.id, artifact.version, artifact.sessionId, artifact.updatedAt, serialize(artifact));
  }

  async getArtifact(artifactId: string): Promise<Artifact | undefined> {
    return readPayload<Artifact>(this.database.prepare(`
      SELECT payload FROM artifacts WHERE artifact_id = ? ORDER BY version DESC LIMIT 1
    `).get(artifactId));
  }

  async listArtifacts(sessionId: string): Promise<Artifact[]> {
    return this.database.prepare(`
      SELECT payload FROM artifacts WHERE session_id = ? ORDER BY updated_at ASC, version ASC
    `).all(sessionId).map((row) => parsePayload<Artifact>(row));
  }

  async saveDecision(decision: UserDecision): Promise<void> {
    this.database.prepare(`
      INSERT INTO user_decisions (id, session_id, created_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run(decision.id, decision.sessionId, decision.createdAt, serialize(decision));
  }

  async listDecisions(sessionId: string): Promise<UserDecision[]> {
    return this.database.prepare(`
      SELECT payload FROM user_decisions WHERE session_id = ? ORDER BY created_at ASC, id ASC
    `).all(sessionId).map((row) => parsePayload<UserDecision>(row));
  }

  async saveDirection(direction: UserDirection): Promise<void> {
    this.database.prepare(`
      INSERT INTO user_directions (id, session_id, created_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run(direction.id, direction.sessionId, direction.createdAt, serialize(direction));
  }

  async listDirections(sessionId: string): Promise<UserDirection[]> {
    return this.database.prepare(`
      SELECT payload FROM user_directions WHERE session_id = ? ORDER BY created_at ASC, id ASC
    `).all(sessionId).map((row) => parsePayload<UserDirection>(row));
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS runtime_events_session_sequence
        ON runtime_events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (artifact_id, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS artifacts_session_version
        ON artifacts(session_id, artifact_id, version);

      CREATE TABLE IF NOT EXISTS user_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS user_decisions_session_created
        ON user_decisions(session_id, created_at);

      CREATE TABLE IF NOT EXISTS user_directions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS user_directions_session_created
        ON user_directions(session_id, created_at);
    `);
  }

  private insertArtifactVersion(artifact: Artifact): void {
    this.database.prepare(`
      INSERT INTO artifacts (artifact_id, version, session_id, updated_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(artifact.id, artifact.version, artifact.sessionId, artifact.updatedAt, serialize(artifact));
  }

  private insertDecision(decision: UserDecision): void {
    this.database.prepare(`
      INSERT INTO user_decisions (id, session_id, created_at, payload) VALUES (?, ?, ?, ?)
    `).run(decision.id, decision.sessionId, decision.createdAt, serialize(decision));
  }

  private insertDirection(direction: UserDirection): void {
    this.database.prepare(`
      INSERT INTO user_directions (id, session_id, created_at, payload) VALUES (?, ?, ?, ?)
    `).run(direction.id, direction.sessionId, direction.createdAt, serialize(direction));
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function readPayload<T>(row: unknown): T | undefined {
  return row ? parsePayload<T>(row) : undefined;
}

function parsePayload<T>(row: unknown): T {
  return JSON.parse((row as PayloadRow).payload) as T;
}
