let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readFrames();
});

function readFrames() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const message = JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.slice(bodyEnd);
    handle(message);
  }
}

function handle(message) {
  if (!message.id) {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-winagent-mcp", version: "0.1.0" }
      }
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo_context",
            description: "Echo a context summary for WinAgent smoke tests.",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" }
              }
            }
          }
        ]
      }
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unknown method: ${message.method}` }
  });
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
