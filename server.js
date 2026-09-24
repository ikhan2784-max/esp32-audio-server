const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const listeners = new Set();
const sources = new Set();

app.get("/", (req, res) => {
  res.json({
    service: "ESP32 Audio WebSocket Relay",
    status: "ok",
    websocket: "/ws",
    listener: "/listener",
    listeners: listeners.size,
    sources: sources.size
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/listener", (req, res) => {
  res.sendFile(__dirname + "/listener.html");
});

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;

  ws.role = "unknown";
  ws.isAlive = true;

  console.log(`WebSocket connected: ${ip}`);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.send(JSON.stringify({
    type: "welcome",
    message: "ESP32 Audio Relay connected"
  }));

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString();

      try {
        const message = JSON.parse(text);

        if (message.type === "listener") {
          ws.role = "listener";
          listeners.add(ws);

          console.log(
            `Listener registered: ${ip} (listeners=${listeners.size})`
          );

          ws.send(JSON.stringify({
            type: "listener_ready",
            sample_rate: 16000,
            format: "pcm16",
            channels: 1
          }));
          return;
        }

        if (
          message.type === "hello" &&
          message.device === "ESP32-S3-ICS43434"
        ) {
          ws.role = "source";
          sources.add(ws);

          console.log(
            `ESP32 audio source registered: ${ip} (sources=${sources.size})`
          );
          return;
        }
      } catch {
        // Ignore non-JSON text.
      }

      console.log("Text:", text);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      }
      return;
    }

    if (ws.role !== "source") {
      console.log(
        `Binary packet from unregistered client: ${data.length} bytes`
      );
      return;
    }

    console.log(
      `Audio packet received: ${data.length} bytes; ` +
      `forwarding to ${listeners.size} listener(s)`
    );

    for (const listener of listeners) {
      if (listener.readyState === WebSocket.OPEN) {
        listener.send(data, { binary: true });
      }
    }
  });

  ws.on("close", () => {
    listeners.delete(ws);
    sources.delete(ws);

    console.log(
      `WebSocket disconnected: ${ip} ` +
      `(listeners=${listeners.size}, sources=${sources.size})`
    );
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.on("close", () => clearInterval(heartbeat));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP/WebSocket server listening on port ${PORT}`);
  console.log("WebSocket endpoint: /ws");
  console.log("Listener page: /listener");
});
