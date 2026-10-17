"use strict";

function addListenerWithinLimit(listeners, listener, limit) {
    if (!(listeners instanceof Set) || !listener || !Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError("listeners, listener, and a positive integer limit are required");
    }
    if (listeners.has(listener)) return true;
    if (listeners.size >= limit) return false;
    listeners.add(listener);
    return true;
}

module.exports = { addListenerWithinLimit };
