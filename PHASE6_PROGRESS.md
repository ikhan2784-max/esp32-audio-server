# Phase 6 — Render security and multi-device control

**Status:** In progress. Multi-device selection and signaling isolation are implemented locally in this slice; this has not been tested or deployed. This file is not a completion claim.

## Implemented in this slice

- Listener PIN verification compares fixed-size HMAC digests with Node's timing-safe comparison.
- In-memory listener sessions remain limited to 24 hours and are capped at 4,096 entries. Expired entries are removed during lookup/creation and periodic cleanup; when full, the oldest session is evicted.
- Failed-PIN rate-limit state remains 10 attempts per client per 15 minutes and is capped at 8,192 client entries. Old windows are pruned and the oldest tracked entry is evicted when full.
- Added automated tests for exact/incorrect PINs, session expiry and capacity, and rate-limit behavior/capacity.
- Authentication rate limiting now keys clients from Render's `CF-Connecting-IP` header after validating it as a single IP address. It ignores caller-controlled `X-Forwarded-For` and falls back to the socket address if the trusted header is absent or malformed.
- Added tests for IPv4/IPv6 forwarding, spoofed `X-Forwarded-For`, malformed proxy data, and fallback behavior.
- Listener sessions now expire after 30 minutes without activity and still have a 24-hour absolute lifetime. User interaction refreshes the idle expiry, and active legacy/WebRTC listening sends a bounded five-minute heartbeat. Expired listener WebSockets are closed by the server; browser pages return to sign-in after expiry.
- Added idle refresh and absolute lifetime tests; the activity endpoint only renews a currently valid same-origin session.
- Authenticated POST endpoints and cookie-authenticated WebSocket connections now require an exact same-origin match, including behind Render's HTTPS proxy. This blocks cross-origin requests to reboot/forget-Wi-Fi controls and signaling.
- WebSocket admission is capped at 64 total connections, legacy audio listeners at four, and WebRTC remains one listener per device; a second WebRTC listener is rejected without displacing the active one.
- Added tests for listener capacity and WebRTC single-listener isolation.
- Legacy listener authentication and every subsequent listener WebSocket message now recheck the live session, so an expired session cannot use the gap before the periodic socket sweep to issue controls. Legacy ESP32 source-token checks use the same timing-safe comparison helper as WebRTC.
- Added tests for the live legacy-listener session guard.
- WebRTC source-token comparison uses the shared timing-safe helper and rejects empty/unset credentials.
- Added authenticated `GET /api/webrtc-status`, reporting the WebRTC device, listener, and session state separately from legacy PCM status. The response is marked `no-store`.
- Added an HTTP integration test for unauthenticated rejection and authenticated WebRTC status.
- Restored a bounded per-device credential registry. `SOURCE_TOKEN` retains the legacy `ESP32-S3-INMP441` identity; `DEVICE_CREDENTIALS_JSON` maps unique additional tokens to device IDs. The default cap is 16 identities.
- WebRTC signaling, listener sessions, gain controls, and restart controls are scoped to each device ID. The existing firmware can derive its ID from the unique token, so no Phase 1–4 source changes are required.
- Added authenticated `/api/devices` and `/api/devices/:deviceId/status` endpoints. Responses contain IDs and connection state only, never tokens.
- Added a device selector to the top of the Phase 7 listener page. Changing the selected device switches its signaling session; the browser remembers the selection.
- Restart is routed through the selected device's authenticated WebRTC session. Wi-Fi reset is disabled in this page because the existing legacy endpoint broadcasts to all legacy sources.
- Detailed firmware diagnostics are not yet available per device. The UI now marks those fields unavailable instead of reading another legacy source's health response.
- This local change has not been tested, deployed to Render, or exercised with multiple physical ESP32 boards.

## Still open

- Sessions, rate limits, device state, and WebRTC pairing are process-local. They are not shared across instances and do not survive restarts.
- WebRTC device registrations and sessions are process-local and reset on service restart; deployment must remain a single Render instance unless session/device state is moved to shared storage.
- Confirm Render's trusted client-IP header behavior with an authenticated edge request before treating IP-based rate limiting as fully verified.
- Verify browser login, logout, listener WebSocket, and control requests from the staging origin; foreign/missing origins are covered by helper tests.
- Verify idle session timeout and active WebRTC listener expiry against the deployed browser flow; automated state tests cover expiry and renewal.
- Configure a unique token for each physical board in Render and its local ignored `sdkconfig`, then verify multiple devices connect, can be selected, and remain isolated when sessions restart or disconnect.
- Verify the selector, gain control, and targeted restart from the deployed browser page. Confirm the legacy Wi-Fi reset action remains unavailable on this page.
- Add per-device health/telemetry and per-user/device authorization rules.
- Validate signaling and media across separate networks; the current peer path is STUN-only and has no TURN relay.
- Run staging soak, restart/reconnect, logout/expiry, and concurrent-client tests before calling Phase 6 complete.
