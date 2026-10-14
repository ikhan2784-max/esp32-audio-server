"use strict";

const crypto = require("crypto");

const DEFAULT_DEVICE_ID = "ESP32-S3-INMP441";
const MAX_DEVICE_ID_LENGTH = 64;
const MAX_DEVICE_TOKEN_LENGTH = 512;
const MAX_CREDENTIAL_JSON_LENGTH = 512 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isValidDeviceId(value) {
    return typeof value === "string" && value.length <= MAX_DEVICE_ID_LENGTH &&
        DEVICE_ID_PATTERN.test(value);
}

function parseCredentialEntries({ sourceToken = "", deviceCredentialsJson = "", maxDevices = 16 } = {}) {
    if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 256) {
        throw new TypeError("maxDevices must be a safe integer between 1 and 256");
    }

    const entries = new Map();
    if (sourceToken) {
        if (typeof sourceToken !== "string" || sourceToken.length > MAX_DEVICE_TOKEN_LENGTH) {
            throw new TypeError("SOURCE_TOKEN has an invalid length");
        }
        entries.set(DEFAULT_DEVICE_ID, sourceToken);
    }

    if (deviceCredentialsJson) {
        if (typeof deviceCredentialsJson !== "string" ||
            deviceCredentialsJson.length > MAX_CREDENTIAL_JSON_LENGTH) {
            throw new TypeError("DEVICE_CREDENTIALS_JSON exceeds the configuration size limit");
        }
        let parsed;
        try {
            parsed = JSON.parse(deviceCredentialsJson);
        } catch {
            throw new TypeError("DEVICE_CREDENTIALS_JSON must be a JSON object");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new TypeError("DEVICE_CREDENTIALS_JSON must be a JSON object");
        }
        for (const [deviceId, token] of Object.entries(parsed)) {
            if (!isValidDeviceId(deviceId)) {
                throw new TypeError("DEVICE_CREDENTIALS_JSON contains an invalid device ID");
            }
            if (entries.has(deviceId)) {
                throw new TypeError("Device credentials overlap SOURCE_TOKEN; use one credential source per device");
            }
            if (typeof token !== "string" || token.length === 0 || token.length > MAX_DEVICE_TOKEN_LENGTH) {
                throw new TypeError("DEVICE_CREDENTIALS_JSON contains an invalid token");
            }
            entries.set(deviceId, token);
        }
    }

    if (entries.size > maxDevices) {
        throw new TypeError(`Configured device count exceeds MAX_CONFIGURED_DEVICES (${maxDevices})`);
    }

    const tokenIds = new Set();
    for (const token of entries.values()) {
        if (tokenIds.has(token)) throw new TypeError("Each configured device must have a unique token");
        tokenIds.add(token);
    }
    return entries;
}

function createDeviceCredentialRegistry({
    sourceToken = "",
    deviceCredentialsJson = "",
    maxDevices = 16,
    pepper = crypto.randomBytes(32),
} = {}) {
    if (!Buffer.isBuffer(pepper) || pepper.length < 32) {
        throw new TypeError("pepper must be a Buffer of at least 32 bytes");
    }
    const entries = parseCredentialEntries({ sourceToken, deviceCredentialsJson, maxDevices });
    const tokenDigests = new Map();
    for (const [deviceId, token] of entries) {
        tokenDigests.set(deviceId, crypto.createHmac("sha256", pepper).update(token, "utf8").digest());
    }
    const dummyDigest = crypto.createHmac("sha256", pepper)
        .update(crypto.randomBytes(32)).digest();

    function authenticate(claimedDeviceId, suppliedToken) {
        const token = typeof suppliedToken === "string" && suppliedToken.length <= MAX_DEVICE_TOKEN_LENGTH
            ? suppliedToken
            : "";
        const suppliedDigest = crypto.createHmac("sha256", pepper).update(token, "utf8").digest();
        let matchedId = null;

        if (claimedDeviceId !== undefined && claimedDeviceId !== null) {
            const expectedDigest = isValidDeviceId(claimedDeviceId)
                ? tokenDigests.get(claimedDeviceId) || dummyDigest
                : dummyDigest;
            const equal = crypto.timingSafeEqual(expectedDigest, suppliedDigest);
            if (equal && tokenDigests.has(claimedDeviceId)) matchedId = claimedDeviceId;
            return matchedId;
        }

        for (const [deviceId, expectedDigest] of tokenDigests) {
            const equal = crypto.timingSafeEqual(expectedDigest, suppliedDigest);
            if (equal) matchedId = deviceId;
        }
        if (tokenDigests.size === 0) crypto.timingSafeEqual(dummyDigest, suppliedDigest);
        return matchedId;
    }

    return Object.freeze({
        authenticate,
        has: (deviceId) => tokenDigests.has(deviceId),
        list: () => Array.from(tokenDigests.keys()),
        size: tokenDigests.size,
    });
}

module.exports = {
    DEFAULT_DEVICE_ID,
    MAX_DEVICE_ID_LENGTH,
    MAX_DEVICE_TOKEN_LENGTH,
    createDeviceCredentialRegistry,
    isValidDeviceId,
    parseCredentialEntries,
};
