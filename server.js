import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {

  if (req.url === "/listener.html") {

    const file = fs.readFileSync(
      path.join(".", "listener.html")
    );

    res.writeHead(200, {
      "Content-Type": "text/html",
    });

    res.end(file);
    return;
  }

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

  if (req.headers["sec-websocket-protocol"] === "listener") {
    listeners.push(ws);
    console.log("Listener added");
  }

  ws.on("message", (data) => {

    for (let l of listeners) {
      if (l.readyState === 1) {
        l.send(data);
      }
    }

  });

  ws.on("close", () => {
    listeners = listeners.filter(l => l !== ws);
  });

});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});