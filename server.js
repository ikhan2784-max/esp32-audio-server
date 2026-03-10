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

let listeners = [];

wss.on("connection", (ws, req) => {
  console.log("WS connected");

  ws.on("message", (data) => {

    // if audio from ESP, send to listeners
    for (let l of listeners) {
      if (l.readyState === 1) {
        l.send(data);
      }
    }

  });

  ws.on("close", () => {
    listeners = listeners.filter(l => l !== ws);
  });

  // mark browser listeners
  if (req.headers["sec-websocket-protocol"] === "listener") {
    listeners.push(ws);
    console.log("Listener added");
  }
});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});