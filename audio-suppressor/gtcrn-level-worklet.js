"use strict";

const GTCRN_LEVELS = {
  low: { thresholdDbfs: -60, attenuation: 0.50 },
  medium: { thresholdDbfs: -54, attenuation: 0.25 },
  high: { thresholdDbfs: -48, attenuation: 0.125 },
};

class GtcrnLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.level = "medium";
    this.gain = 1;
    this.port.onmessage = (event) => {
      const next = event.data && event.data.level;
      if (Object.prototype.hasOwnProperty.call(GTCRN_LEVELS, next)) {
        this.level = next;
      }
    };
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    if (!outputChannels || outputChannels.length === 0) return true;
    if (!inputChannels || inputChannels.length === 0) {
      for (const output of outputChannels) output.fill(0);
      this.gain = 1;
      return true;
    }

    let sumSquares = 0;
    let sampleCount = 0;
    for (const channel of inputChannels) {
      for (let i = 0; i < channel.length; i++) {
        const value = channel[i];
        sumSquares += value * value;
      }
      sampleCount += channel.length;
    }
    const rms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -120;
    const profile = GTCRN_LEVELS[this.level];
    const kneeDb = 12;
    const lower = profile.thresholdDbfs - kneeDb / 2;
    const upper = profile.thresholdDbfs + kneeDb / 2;
    let targetGain;
    if (dbfs >= upper) targetGain = 1;
    else if (dbfs <= lower) targetGain = profile.attenuation;
    else {
      const position = (dbfs - lower) / (upper - lower);
      targetGain = profile.attenuation + position * (1 - profile.attenuation);
    }

    const sampleRateSafe = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const frameLength = Math.min(...outputChannels.map((channel) => channel.length));
    for (let i = 0; i < frameLength; i++) {
      const tauSeconds = targetGain < this.gain ? 0.035 : 0.008;
      const smoothing = 1 - Math.exp(-1 / (sampleRateSafe * tauSeconds));
      this.gain += (targetGain - this.gain) * smoothing;
      for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex++) {
        const input = inputChannels[Math.min(channelIndex, inputChannels.length - 1)];
        outputChannels[channelIndex][i] = input ? input[i] * this.gain : 0;
      }
    }
    return true;
  }
}

registerProcessor("gtcrn-level-control", GtcrnLevelProcessor);
