import type { Server } from "node:http";
import { URL } from "node:url";
import { WebSocketServer } from "ws";
import type { WebSocketEnvelope } from "../shared/events";
import { EventBus } from "./eventBus";
import type { RunRepository } from "./repositories";

export class WebSocketGateway {
  private readonly wss: WebSocketServer;

  constructor(server: Server, events: EventBus, runs: RunRepository) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    events.onRunEvent((event) => {
      this.broadcast({ kind: "run.event", event });
    });
    this.wss.on("connection", (socket, request) => {
      socket.send(JSON.stringify({ kind: "server.ready" } satisfies WebSocketEnvelope));
      const url = new URL(request.url ?? "/ws", "http://127.0.0.1");
      const runId = url.searchParams.get("runId");
      const after = Number(url.searchParams.get("after") ?? 0);
      if (runId) {
        for (const event of runs.events(runId).filter((item) => item.sequence > after)) {
          socket.send(
            JSON.stringify({
              kind: "run.event",
              event: {
                id: event.id,
                runId: event.runId,
                sequence: event.sequence,
                type: event.type as any,
                payload: event.payload as Record<string, unknown>,
                createdAt: event.createdAt
              }
            } satisfies WebSocketEnvelope)
          );
        }
      }
    });
  }

  private broadcast(envelope: WebSocketEnvelope): void {
    const message = JSON.stringify(envelope);
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }
}
