"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
    path.join(__dirname, "..", "audio-suppressor", "gtcrn-level-worklet.js"),
    "utf8"
);

function createProcessor() {
    let ProcessorClass;
    const scope = {
        sampleRate: 48000,
        AudioWorkletProcessor: class {
            constructor() { this.port = { onmessage: null }; }
        },
        registerProcessor(name, processorClass) {
            assert.equal(name, "gtcrn-level-control");
            ProcessorClass = processorClass;
        },
        Math,
        Number,
        Object,
    };
    vm.runInNewContext(source, scope, { filename: "gtcrn-level-worklet.js" });
    return new ProcessorClass();
}

function runQuietFrames(level) {
    const processor = createProcessor();
    processor.port.onmessage({ data: { level } });
    const input = new Float32Array(128).fill(0.001);
    let output;
    for (let frame = 0; frame < 48; frame++) {
        output = new Float32Array(128);
        processor.process([[input]], [[output]]);
    }
    return { processor, output };
}

test("post-GTCRN quiet-audio profiles apply progressively stronger attenuation", () => {
    const low = runQuietFrames("low");
    const medium = runQuietFrames("medium");
    const high = runQuietFrames("high");

    assert.ok(low.processor.gain < 1);
    assert.ok(medium.processor.gain < low.processor.gain);
    assert.ok(high.processor.gain < medium.processor.gain);
    assert.ok(Math.abs(high.output[64]) < Math.abs(medium.output[64]));
    assert.ok(Math.abs(medium.output[64]) < Math.abs(low.output[64]));
});

test("loud speech-range samples pass through at unity after the envelope settles", () => {
    const processor = createProcessor();
    processor.port.onmessage({ data: { level: "high" } });
    const input = new Float32Array(128).fill(0.1);
    let output;
    for (let frame = 0; frame < 48; frame++) {
        output = new Float32Array(128);
        processor.process([[input]], [[output]]);
    }
    assert.ok(processor.gain > 0.98);
    assert.ok(Math.abs(output[64] - input[64]) < 0.003);
});
