import { WebSocketServer } from 'ws';
import http from 'http';

const server = http.createServer();
const wss = new WebSocketServer({ server });

let listeners = [];

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const type = url.searchParams.get('type');

  console.log("New connection:", type);

  if (type === 'esp') {

    console.log("ESP connected");

    ws.on('message', (data) => {
      // Broadcast audio to all listeners
      for (const client of listeners) {
        if (client.readyState === 1) {
          client.send(data);
        }
      }
    });

  } else if (type === 'listen') {

    console.log("Listener connected");
    listeners.push(ws);

    ws.on('close', () => {
      console.log("Listener disconnected");
      listeners = listeners.filter(c => c !== ws);
    });

  } else {
    ws.close();
  }
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});