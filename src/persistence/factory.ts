import { resolve } from "node:path";
import type { PersistenceAdapter } from "./persistence.js";
import { InMemoryPersistence } from "./inMemoryPersistence.js";
import { SqlitePersistence } from "./sqlitePersistence.js";

export function createConfiguredPersistence(env: NodeJS.ProcessEnv = process.env): PersistenceAdapter {
  const implementation = env.INBETWEEN_PERSISTENCE ?? "sqlite";
  if (implementation === "memory") return new InMemoryPersistence();
  if (implementation !== "sqlite") {
    throw new Error(`Unsupported persistence implementation: ${implementation}`);
  }

  const dataDirectory = env.INBETWEEN_DATA_DIR ?? ".inbetween-data";
  const databasePath = env.INBETWEEN_SQLITE_PATH ?? resolve(dataDirectory, "inbetween.sqlite");
  return new SqlitePersistence(databasePath);
}
