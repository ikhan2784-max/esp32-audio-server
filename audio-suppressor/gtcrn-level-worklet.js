"use strict";

const GTCRN_LEVELS = {
  low: { thresholdDbfs: -63, attenuation: 0.82 },
  medium: { thresholdDbfs: -58, attenuation: 0.68 },
  high: { thresholdDbfs: -53, attenuation: 0.55 },
};

const SPEECH_HOLD_DBFS = -56;
const SPEECH_HOLD_MS = 350;
const SUPPRESSION_SMOOTHING_SECONDS = 0.18;
const SPEECH_RECOVERY_SECONDS = 0.012;

class GtcrnLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.level = "medium";
    this.gain = 1;
    this.speechHoldSamples = 0;
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
      this.speechHoldSamples = 0;
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
    const sampleRateSafe = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const frameLength = Math.min(...outputChannels.map((channel) => channel.length));
    let targetGain;
    if (dbfs >= SPEECH_HOLD_DBFS) {
      this.speechHoldSamples = Math.round(sampleRateSafe * SPEECH_HOLD_MS / 1000);
    }
    if (this.speechHoldSamples > 0) targetGain = 1;
    else if (dbfs <= lower) targetGain = profile.attenuation;
    else {
      const position = (dbfs - lower) / (upper - lower);
      targetGain = profile.attenuation + position * (1 - profile.attenuation);
    }

    for (let i = 0; i < frameLength; i++) {
      // Apply suppression gradually and restore speech quickly. The envelope
      // avoids chopping quiet consonants and the tail between adjacent syllables.
      const tauSeconds = targetGain < this.gain
        ? SUPPRESSION_SMOOTHING_SECONDS
        : SPEECH_RECOVERY_SECONDS;
      const smoothing = 1 - Math.exp(-1 / (sampleRateSafe * tauSeconds));
      this.gain += (targetGain - this.gain) * smoothing;
      for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex++) {
        const input = inputChannels[Math.min(channelIndex, inputChannels.length - 1)];
        outputChannels[channelIndex][i] = input ? input[i] * this.gain : 0;
      }
    }
    this.speechHoldSamples = Math.max(0, this.speechHoldSamples - frameLength);
    return true;
  }
}

registerProcessor("gtcrn-level-control", GtcrnLevelProcessor);
