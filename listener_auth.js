"use strict";

function hasValidListenerSession(ws) {
    return !!ws && ws.role === "listener" && ws.authenticated === true &&
        typeof ws.sessionValid === "function" && ws.sessionValid() === true;
}

module.exports = { hasValidListenerSession };
