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
