// ========================================================
// ESP32 REMOTE REBOOT
// ========================================================

if (
  message.type === "esp32_reboot" &&
  ws.role === "listener" &&
  ws.authenticated
) {

  console.log(
    `Authenticated listener requested ESP32 reboot: ${ip}`
  );

  let forwarded = false;

  for (const source of sources) {
    if (
      source.readyState === WebSocket.OPEN &&
      source.role === "source" &&
      source.authenticated
    ) {
      sendJson(source, {
        type: "esp32_reboot"
      });

      forwarded = true;
    }
  }

  sendJson(ws, {
    type: "reboot_requested",
    source_connected: forwarded
  });

  return;
}
