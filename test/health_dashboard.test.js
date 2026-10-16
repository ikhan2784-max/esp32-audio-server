"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "webrtc-listener.html"), "utf8");
const helperMatch = html.match(/^function healthCounterStatus\(values, positiveStatus\) \{[\s\S]*?^\}/m);
assert.ok(helperMatch, "healthCounterStatus helper must exist in the listener page");
const healthCounterStatus = vm.runInNewContext(`(${helperMatch[0]})`);
const taskHelperMatch = html.match(/^function healthBooleanGroupStatus\(values, falseStatus = "Warning"\) \{[\s\S]*?^\}/m);
assert.ok(taskHelperMatch, "healthBooleanGroupStatus helper must exist in the listener page");
const healthBooleanGroupStatus = vm.runInNewContext(`(${taskHelperMatch[0]})`);

test("health counters are healthy only when every counter is reported and zero", () => {
    assert.equal(healthCounterStatus([0, 0, 0], "Critical"), "Healthy");
});

test("missing health counters are not classified as failures", () => {
    assert.equal(healthCounterStatus([0, undefined, 0], "Critical"), "Not Tested");
    assert.equal(healthCounterStatus([undefined, null], "Critical"), "Not Tested");
});

test("any measured nonzero counter keeps its configured alert status", () => {
    assert.equal(healthCounterStatus([0, 1, undefined], "Warning"), "Warning");
    assert.equal(healthCounterStatus([0, 1, 0], "Critical"), "Critical");
});

test("DSP counter alerts are separate from current DSP task state", () => {
    assert.match(html, /healthCounterStatus\(\[d\.dsp_errors, d\.dsp_input_underflows, d\.dsp_output_overflows\], "Warning"\)/);
    assert.match(html, /healthBool\(hasData \? d\.dsp_running : undefined,[\s\S]{0,120}"Critical"\)/);
});

test("task health does not call missing task measurements stopped", () => {
    assert.equal(healthBooleanGroupStatus([true, true, true]), "Healthy");
    assert.equal(healthBooleanGroupStatus([true, false, true]), "Warning");
    assert.equal(healthBooleanGroupStatus([true, undefined, true]), "Not Tested");
    assert.match(html, /Capture \$\{taskStateText\(d\.audio_capture_running\)\} · DSP \$\{taskStateText\(d\.dsp_running\)\} · WebRTC \$\{taskStateText\(d\.webrtc_running\)\}/);
});

test("gain controls are separated between Settings and Listener with safe defaults", () => {
    const listenerPanel = html.indexOf('id="panel-listener"');
    const settingsPanel = html.indexOf('id="panel-settings"');
    const listenerVolume = html.indexOf('id="listenerVolume"');
    const settingsBoost = html.indexOf('id="playVolume"');

    assert.ok(listenerPanel >= 0 && settingsPanel > listenerPanel);
    assert.ok(listenerVolume > listenerPanel && listenerVolume < settingsPanel,
        "master volume must stay on the Listener page");
    assert.ok(settingsBoost > settingsPanel,
        "the existing playback boost must move into Settings");
    assert.match(html, /id="autoGain" type="checkbox" checked/);
    assert.match(html, /id="micGain" type="range" min="25" max="200" step="5" value="50"/);
    assert.match(html, /id="playVolume" type="range" min="0" max="300" step="1" value="0"/);
    assert.match(html, /id="listenerVolume" type="range" min="0" max="300" step="1" value="100"/);
    assert.match(html, /const selectedGain = Math\.min\(3, boostGain \* volumeGain\)/);
    assert.match(html, /micGainEl\.value = "50"/);
});

test("audio-processing controls expose four levels with tested defaults", () => {
    for (const [id, selected] of [
        ["gtcrnLevel", "medium"],
        ["firmwareNoiseSuppression", "off"],
        ["firmwareVad", "medium"],
        ["firmwareLimiter", "low"],
    ]) {
        const elementStart = html.indexOf(`id="${id}"`);
        assert.ok(elementStart >= 0, `${id} control should exist`);
        const selectStart = html.lastIndexOf("<select", elementStart);
        const selectEnd = html.indexOf("</select>", elementStart);
        const selectMarkup = html.slice(selectStart, selectEnd + "</select>".length);
        for (const level of ["off", "low", "medium", "high"]) {
            assert.match(selectMarkup, new RegExp(`option value="${level}"`), `${id} should offer ${level}`);
        }
        assert.match(selectMarkup, new RegExp(`option value="${selected}" selected`), `${id} should default to ${selected}`);
    }
    assert.match(html, /noise_suppression_level: firmwareNoiseSuppressionEl\.value/);
    assert.match(html, /vad_level: firmwareVadEl\.value/);
    assert.match(html, /limiter_level: firmwareLimiterEl\.value/);
    assert.match(html, /gtcrnLevelEl\.addEventListener\("change"/);
});

test("play timer stays hidden while waiting and accumulates only actual playback", () => {
    const extract = (name) => {
        const match = html.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"));
        assert.ok(match, `${name} helper should exist`);
        return match[0];
    };
    let now = 0;
    let nextInterval = 1;
    const context = vm.createContext({
        performance: { now: () => now },
        window: {
            setInterval: () => nextInterval++,
            clearInterval: () => {},
        },
        listeningElapsedMs: 0,
        listeningStartedAtMs: 0,
        listeningTimerInterval: null,
        listeningTimerEl: { hidden: true, textContent: "" },
        listenerActive: true,
        audioEl: { paused: true, readyState: 0 },
        peer: { connectionState: "connecting" },
        hasPlayableAudioTrack: () => false,
    });
    vm.runInContext([
        extract("formatElapsedClock"),
        extract("refreshListeningTimerText"),
        extract("startListeningTimer"),
        extract("stopListeningTimer"),
    ].join("\n"), context);

    vm.runInContext("startListeningTimer()", context);
    assert.equal(context.listeningTimerEl.hidden, true);
    assert.equal(context.listeningTimerInterval, null);

    context.audioEl.paused = false;
    context.audioEl.readyState = 2;
    context.hasPlayableAudioTrack = () => true;
    vm.runInContext("startListeningTimer()", context);
    assert.equal(context.listeningTimerEl.hidden, true, "a track must not count while the peer is still connecting");

    context.peer.connectionState = "connected";
    now = 1000;
    vm.runInContext("startListeningTimer()", context);
    now = 6100;
    vm.runInContext("stopListeningTimer()", context);
    assert.equal(context.listeningTimerEl.hidden, true);
    assert.equal(context.listeningElapsedMs, 5100);

    now = 8000;
    vm.runInContext("startListeningTimer()", context);
    assert.equal(context.listeningTimerEl.hidden, false);
    assert.equal(context.listeningTimerEl.textContent, "PLAY 00:05");
    assert.match(html, /audioEl\.addEventListener\("playing", \(\) => \{[\s\S]{0,140}startListeningTimer\(\)/);
    const unmuteHandler = html.match(/track\.addEventListener\("unmute", \(\) => \{[\s\S]*?\n      \}\);/);
    assert.ok(unmuteHandler && unmuteHandler[0].includes('peer.connectionState === "connected"') &&
        unmuteHandler[0].includes("audioEl.readyState >= 2") && unmuteHandler[0].includes("hasPlayableAudioTrack()") &&
        unmuteHandler[0].includes("startListeningTimer()"), "audio-track recovery should resume the timer only when media data is ready");
    for (const event of ["waiting", "pause", "ended"]) {
        const handler = html.match(new RegExp(`audioEl\\.addEventListener\\("${event}",[\\s\\S]{0,180}?\\n\\}\\);`));
        assert.ok(handler && handler[0].includes("stopListeningTimer()"), `${event} should hide/pause the play timer`);
    }
});
