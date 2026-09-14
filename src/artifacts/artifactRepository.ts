import type { Artifact } from "../shared/types.js";

export interface ArtifactRepository {
  save(artifact: Artifact): Promise<void>;
  get(artifactId: string): Promise<Artifact | undefined>;
  listForSession(sessionId: string): Promise<Artifact[]>;
}
