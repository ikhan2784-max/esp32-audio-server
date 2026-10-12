# Phase 5 WebRTC signaling path

This branch adds an authenticated, one-device/one-listener signaling session at the existing `/ws` WebSocket endpoint. The ESP32 proves its role with the `SOURCE_TOKEN` environment variable; the listener must have an authenticated web session. Render forwards bounded offer/answer SDP and trickled ICE candidates. It does not accept binary audio from these WebRTC roles.

The existing `/listener` route and PCM relay remain unchanged. After PIN login, the staging service opens the WebRTC listener at `/phase5-listener` by default. Browser recording stays local to the browser and has a bounded 128 MiB recording buffer. Recording defaults to the raw incoming WebRTC track for noise diagnosis; the listener output after GTCRN can also be selected. Filenames identify the selected source.

The listener status reports Web Audio input and output RMS levels in dBFS to distinguish a quiet remote track from a silent GTCRN output. If the GTCRN worklet raises a processor error, the page bypasses it, restores direct audio, and marks noise suppression off.

WebRTC media is direct peer-to-peer in this implementation. Render provides signaling only; it does not relay Opus media. The device and page use STUN for direct ICE, and no TURN server is configured, so some NAT/firewall combinations will fail. This branch is not a production deployment or end-to-end acceptance result until the ESP32 firmware is integrated and tested with the listener.

Run the local signaling checks with:

```powershell
node --check server.js
node --check webrtc_signaling.js
node --test test\webrtc_signaling.test.js
```
