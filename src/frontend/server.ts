import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import type { WorkRuntime } from "../runtime/workRuntime.js";
import { USER_DIRECTION_VALUES, type UserDirectionValue } from "../shared/types.js";
import type { AcceptedCommand, ApiError, CreateSessionRequest, SubmitDecisionRequest, SubmitDirectionRequest } from "./contracts.js";

export interface FrontendServerOptions {
  runtime: WorkRuntime;
  publicDirectory?: string;
}

export function createFrontendServer(options: FrontendServerOptions): Server {
  const publicDirectory = options.publicDirectory ?? resolve(process.cwd(), "src", "frontend", "public");
  const activeCommands = new Set<string>();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const body = await readJson<CreateSessionRequest>(request);
        const task = body.task?.trim();
        if (!task) {
          sendJson(response, 400, { error: "Task is required." } satisfies ApiError);
          return;
        }
        sendJson(response, 201, await options.runtime.createSession(task));
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const session = await options.runtime.getSession(decodeURIComponent(sessionMatch[1]!));
        if (!session) {
          sendJson(response, 404, { error: "Session not found." } satisfies ApiError);
          return;
        }
        sendJson(response, 200, session);
        return;
      }

      const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        await openEventStream(options.runtime, decodeURIComponent(eventsMatch[1]!), request, response);
        return;
      }

      const startMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/start$/);
      if (request.method === "POST" && startMatch) {
        const sessionId = decodeURIComponent(startMatch[1]!);
        const session = await options.runtime.getSession(sessionId);
        if (!session) {
          sendJson(response, 404, { error: "Session not found." } satisfies ApiError);
          return;
        }
        if (session.status !== "idle" || activeCommands.has(sessionId)) {
          sendJson(response, 409, { error: `Cannot start a session while it is ${session.status}.` } satisfies ApiError);
          return;
        }
        activeCommands.add(sessionId);
        sendJson(response, 202, { accepted: true, sessionId } satisfies AcceptedCommand);
        void options.runtime.startWork(sessionId).finally(() => activeCommands.delete(sessionId));
        return;
      }

      const decisionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/decisions$/);
      if (request.method === "POST" && decisionMatch) {
        const sessionId = decodeURIComponent(decisionMatch[1]!);
        const session = await options.runtime.getSession(sessionId);
        if (!session) {
          sendJson(response, 404, { error: "Session not found." } satisfies ApiError);
          return;
        }
        if (session.status !== "needs_user" || activeCommands.has(sessionId)) {
          sendJson(response, 409, { error: `Cannot submit a decision while the session is ${session.status}.` } satisfies ApiError);
          return;
        }
        const body = await readJson<SubmitDecisionRequest>(request);
        const answer = body.response?.trim();
        if (!answer) {
          sendJson(response, 400, { error: "A decision response is required." } satisfies ApiError);
          return;
        }
        activeCommands.add(sessionId);
        sendJson(response, 202, { accepted: true, sessionId } satisfies AcceptedCommand);
        void options.runtime
          .respondToUser(sessionId, answer, body.selectedOptionId)
          .finally(() => activeCommands.delete(sessionId));
        return;
      }

      const directionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/directions$/);
      if (request.method === "POST" && directionMatch) {
        const sessionId = decodeURIComponent(directionMatch[1]!);
        const session = await options.runtime.getSession(sessionId);
        if (!session) {
          sendJson(response, 404, { error: "Session not found." } satisfies ApiError);
          return;
        }
        if (session.status !== "working") {
          sendJson(response, 409, { error: `Cannot shape a session while it is ${session.status}.` } satisfies ApiError);
          return;
        }
        const body = await readJson<SubmitDirectionRequest>(request);
        if (!isDirectionValue(body.value)) {
          sendJson(response, 400, { error: "Direction must be minimal, bold, or ai_decide." } satisfies ApiError);
          return;
        }
        sendJson(response, 201, await options.runtime.provideDirection(sessionId, body.value));
        return;
      }

      if (request.method === "GET") {
        serveStatic(publicDirectory, url.pathname, response);
        return;
      }

      sendJson(response, 404, { error: "Not found." } satisfies ApiError);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "Unexpected server error.",
        } satisfies ApiError);
      } else {
        response.end();
      }
    }
  });
}

function isDirectionValue(value: unknown): value is UserDirectionValue {
  return typeof value === "string" && USER_DIRECTION_VALUES.includes(value as UserDirectionValue);
}

async function openEventStream(
  runtime: WorkRuntime,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const session = await runtime.getSession(sessionId);
  if (!session) {
    sendJson(response, 404, { error: "Session not found." } satisfies ApiError);
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    "Content-Type": "text/event-stream",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeServerEvent(response, "session", session);

  const unsubscribe = runtime.subscribe(sessionId, (nextSession, event) => {
    writeServerEvent(response, "runtime", { session: nextSession, event });
  });
  const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

function writeServerEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function serveStatic(publicDirectory: string, pathname: string, response: ServerResponse): void {
  const asset = pathname === "/" ? "index.html" : pathname.slice(1);
  const allowedAssets = new Set(["index.html", "app.js", "styles.css"]);
  if (!allowedAssets.has(asset)) {
    sendJson(response, 404, { error: "Not found." } satisfies ApiError);
    return;
  }

  const filePath = resolve(publicDirectory, asset);
  if (!existsSync(filePath)) {
    sendJson(response, 404, { error: "Frontend asset not found." } satisfies ApiError);
    return;
  }

  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };
  response.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}
