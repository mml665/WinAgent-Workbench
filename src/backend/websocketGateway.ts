import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocketEnvelope } from "../shared/events";
import { EventBus } from "./eventBus";

export class WebSocketGateway {
  private readonly wss: WebSocketServer;

  constructor(server: Server, events: EventBus) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    events.onRunEvent((event) => {
      this.broadcast({ kind: "run.event", event });
    });
    this.wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ kind: "server.ready" } satisfies WebSocketEnvelope));
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
