import { createConfiguredAiProvider } from "../ai/factory.js";
import { loadDotEnv } from "../dev/loadDotEnv.js";
import { createConfiguredPersistence } from "../persistence/factory.js";
import { WorkRuntime } from "../runtime/workRuntime.js";
import { createFrontendServer } from "./server.js";

loadDotEnv();

const port = Number(process.env.INBETWEEN_PORT ?? 4173);
const runtime = new WorkRuntime({
  aiProvider: createConfiguredAiProvider(),
  persistence: createConfiguredPersistence(),
});

const server = createFrontendServer({ runtime });
server.listen(port, "127.0.0.1", () => {
  console.log(`InBetween is running at http://127.0.0.1:${port}`);
});
