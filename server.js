const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

app.get("/", (req, res) => {
  res.json({
    service: "ESP32 Audio WebSocket Relay",
    status: "ok",
    websocket: "/ws",
    clients: wss.clients.size
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`WebSocket connected: ${ip}`);

  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.send(JSON.stringify({
    type: "welcome",
    message: "ESP32 Audio Relay connected"
  }));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      console.log(`Audio packet received: ${data.length} bytes`);

      // For now, echo binary audio back to the sender.
      // Later this will be changed to relay audio to other clients.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
      }
      return;
    }

    const text = data.toString();
    console.log("Text:", text);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
    }
  });

  ws.on("close", () => {
    console.log(`WebSocket disconnected: ${ip}`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// Render can replace instances, so heartbeat helps detect stale sockets.
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
});
