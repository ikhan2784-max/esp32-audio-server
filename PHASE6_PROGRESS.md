# Phase 6 — Render security and multi-device

**Status:** In progress. This file records the first backend-hardening slice; it is not a completion claim.

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

## Multi-device foundation added on the Phase 6 feature branch

These changes are on the local Phase 6 feature branch. The automated backend suite and a local HTTP smoke check pass; this slice has not been deployed to Render or exercised with multiple physical devices:

- Added a bounded credential registry configured with `DEVICE_CREDENTIALS_JSON`; each device token maps to one validated device ID. The existing `SOURCE_TOKEN` remains the credential for `ESP32-S3-INMP441`.
- Device tokens are reduced to keyed digests in the registry, compared with fixed-size timing-safe checks, and never returned by the registry API. Duplicate tokens, conflicting default credentials, invalid IDs, malformed configuration, and over-capacity configurations fail closed.
- WebRTC device/listener pairs, session IDs, signaling, and microphone-gain controls are now scoped to a device ID. A listener for one device cannot relay through another device's session; one listener is allowed per device.
- Added authenticated `/api/devices` and `/api/devices/:deviceId/status` endpoints and a device selector on the WebRTC listener page.
- Existing firmware can keep omitting `device_id`: the server derives the identity from its unique token. If a device ID is supplied later, it must match that token.
- Validation: `npm test` passed 34/34 tests. A local server smoke check verified unauthenticated device listing is rejected (401), listener sign-in succeeds (200), the authenticated device list/status endpoints succeed (200), and test tokens are not returned.
- This is a backend foundation, not Phase 6 completion. A valid listener PIN currently grants access to all configured devices. Per-user/device authorization, device-specific health and control APIs, persistent/shared state, staging browser/device validation, cross-network ICE/TURN validation, and multi-client soak remain open.

## Still open

- Sessions, rate limits, device state, and WebRTC pairing are process-local. They are not shared across instances and do not survive restarts.
- WebRTC signaling now has a configured per-device registry and isolated one-listener-per-device sessions in local code. There is no persistent registry or per-user/device authorization policy yet, and the separate legacy PCM endpoint still follows its single-source contract.
- Confirm Render's trusted client-IP header behavior with an authenticated edge request before treating IP-based rate limiting as fully verified.
- Verify browser login, logout, listener WebSocket, and control requests from the staging origin; foreign/missing origins are covered by helper tests.
- Verify idle session timeout and active WebRTC listener expiry against the deployed browser flow; automated state tests cover expiry and renewal.
- Add per-device health/control APIs beyond signaling status and session microphone gain. Define per-user/device access rules rather than granting every authenticated listener access to all registered devices.
- Validate signaling and media across separate networks; the current peer path is STUN-only and has no TURN relay.
- Run staging soak, restart/reconnect, logout/expiry, and concurrent-client tests before calling Phase 6 complete.
