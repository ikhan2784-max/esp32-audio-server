"use strict";

(() => {
    let listenerActive = false;
    let requestInFlight = false;
    let lastSuccessfulRefresh = 0;

    async function refreshSession(force = false) {
        const now = Date.now();
        if (requestInFlight || (!force && now - lastSuccessfulRefresh < 60 * 1000)) return;
        requestInFlight = true;
        try {
            const response = await fetch("/api/session/activity", {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Accept": "application/json" },
            });
            if (response.status === 401) {
                window.location.replace("/");
                return;
            }
            if (response.ok) {
                lastSuccessfulRefresh = Date.now();
                const session = await response.json().catch(() => null);
                if (session) {
                    window.dispatchEvent(new CustomEvent("sessionactivity", { detail: session }));
                }
            }
        } catch {
            // A later user action or active-listener heartbeat can retry.
        } finally {
            requestInFlight = false;
        }
    }

    window.setListenerActive = (active) => {
        listenerActive = active === true;
        if (listenerActive) void refreshSession(true);
    };

    const noteActivity = () => { void refreshSession(); };
    window.addEventListener("pointerdown", noteActivity, { passive: true });
    window.addEventListener("pointermove", noteActivity, { passive: true });
    window.addEventListener("keydown", noteActivity);
    window.addEventListener("touchstart", noteActivity, { passive: true });
    window.addEventListener("wheel", noteActivity, { passive: true });
    window.addEventListener("scroll", noteActivity, { passive: true });

    window.setInterval(() => {
        if (listenerActive) void refreshSession(true);
    }, 5 * 60 * 1000);
})();
