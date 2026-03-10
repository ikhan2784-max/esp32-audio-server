import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ESP32 Audio Server Running");
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
});

wss.on("connection", (ws, req) => {
  console.log("WS client connected");

  ws.on("message", (data) => {
    console.log("Audio bytes:", data.length);
  });

  ws.on("close", () => {
    console.log("WS disconnected");
  });
});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});