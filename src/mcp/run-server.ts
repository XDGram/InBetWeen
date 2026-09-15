#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConfiguredPersistence } from "../persistence/factory.js";
import { WorkRuntime } from "../runtime/workRuntime.js";
import { createInBetweenMcpServer } from "./server.js";

async function main(): Promise<void> {
  const persistence = createConfiguredPersistence();
  const runtime = new WorkRuntime({ persistence });
  const server = createInBetweenMcpServer({ runtime });
  const transport = new StdioServerTransport();

  process.stderr.write("InBetween MCP server running on stdio.\n");
  await server.connect(transport);

  const close = async () => {
    if ("close" in persistence && typeof persistence.close === "function") {
      persistence.close();
    }
    await server.close();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
}

main().catch((error) => {
  process.stderr.write(`InBetween MCP server failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
