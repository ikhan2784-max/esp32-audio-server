import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200);
    res.end("ESP32 Audio Server Running");
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  noServer: true,
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
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