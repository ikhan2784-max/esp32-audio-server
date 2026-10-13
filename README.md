# ESP32 Audio Render Relay

This is the clean WebSocket server for the new ESP32-S3 + ICS43434 project.

## Phase 6 device credentials

The WebRTC signaling service can authenticate more than one configured device. Keep the existing `SOURCE_TOKEN` as the credential for the legacy ID `ESP32-S3-INMP441`. Additional devices can be configured through Render's environment settings with a `DEVICE_CREDENTIALS_JSON` object whose keys are device IDs and whose values are unique per-device source tokens:

```json
{"living-room":"replace-with-a-random-device-token","workshop":"replace-with-another-random-device-token"}
```

Set `MAX_CONFIGURED_DEVICES` to a positive number from 1 to 256; it defaults to 16. Each configured token must be unique and no longer than 512 characters. Use high-entropy random tokens (at least 32 random bytes). The server maps a WebRTC device's token to its identity, so existing firmware can omit `device_id`; a supplied ID must match the token's configured identity. The authenticated listener page lists configured devices and opens a separate signaling session for the selected one.

Keep actual tokens only in Render environment settings and each board's ignored local build configuration. Never commit them or log them. A valid listener PIN session currently grants administrator access to every configured device; per-user/device access rules remain future Phase 6 work.

The device registry and signaling sessions are still in memory. The service must remain a single instance until shared/persistent session state is implemented and verified. A Render restart disconnects active peers; devices and listeners must reconnect.

Authenticated status endpoints:

- `GET /api/devices` returns configured identities and their WebRTC signaling state.
- `GET /api/devices/:deviceId/status` returns signaling status for one configured identity.

## Endpoint

WebSocket:
wss://YOUR-RENDER-DOMAIN.onrender.com/ws

For the user's current Render service, the endpoint will be:

wss://esp32-audio-server-1.onrender.com/ws

HTTP health:
https://esp32-audio-server-1.onrender.com/health

HTTP status:
https://esp32-audio-server-1.onrender.com/

## Render settings

Create/use a Render **Web Service**.

Build command:
npm install

Start command:
npm start

The server automatically uses Render's `PORT` environment variable and binds to 0.0.0.0.

## Current behavior

- Accepts WebSocket connections at `/ws`
- Sends a JSON welcome message
- Accepts binary messages
- Echoes binary messages back to the same ESP32
- Sends WebSocket ping frames every 30 seconds
- Provides `/health`

The binary echo is intentional for the first test. Once the ESP32 can connect reliably, we can change this into the actual audio relay/receiver architecture.
