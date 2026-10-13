"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    DEFAULT_DEVICE_ID,
    createDeviceCredentialRegistry,
    parseCredentialEntries,
} = require("../device_registry");

test("keeps the existing source token mapped to the default device", () => {
    const registry = createDeviceCredentialRegistry({ sourceToken: "legacy-device-token" });
    assert.deepEqual(registry.list(), [DEFAULT_DEVICE_ID]);
    assert.equal(registry.authenticate(undefined, "legacy-device-token"), DEFAULT_DEVICE_ID);
    assert.equal(registry.authenticate(undefined, "wrong-token"), null);
});

test("maps unique per-device tokens to configured identities without exposing tokens", () => {
    const registry = createDeviceCredentialRegistry({
        sourceToken: "legacy-device-token",
        deviceCredentialsJson: JSON.stringify({ workshop: "workshop-device-token", office: "office-device-token" }),
    });
    assert.equal(registry.authenticate(undefined, "office-device-token"), "office");
    assert.equal(registry.authenticate("workshop", "workshop-device-token"), "workshop");
    assert.equal(registry.authenticate("office", "workshop-device-token"), null);
    assert.equal(registry.has("unknown"), false);
    assert.deepEqual(registry.list(), [DEFAULT_DEVICE_ID, "workshop", "office"]);
    assert.equal(JSON.stringify(registry).includes("office-device-token"), false);
});

test("rejects invalid, duplicate, overlapping, and over-capacity credentials", () => {
    assert.throws(() => parseCredentialEntries({ deviceCredentialsJson: "[]" }), /JSON object/);
    assert.throws(() => parseCredentialEntries({ deviceCredentialsJson: "{\"bad/id\":\"token\"}" }), /invalid device ID/);
    assert.throws(() => parseCredentialEntries({ sourceToken: "same", deviceCredentialsJson: "{\"room\":\"same\"}" }), /unique token/);
    assert.throws(() => parseCredentialEntries({ sourceToken: "default", deviceCredentialsJson: "{\"ESP32-S3-INMP441\":\"override\"}" }), /overlap SOURCE_TOKEN/);
    assert.throws(() => parseCredentialEntries({ deviceCredentialsJson: "{\"a\":\"one\",\"b\":\"two\"}", maxDevices: 1 }), /exceeds MAX_CONFIGURED_DEVICES/);
});
