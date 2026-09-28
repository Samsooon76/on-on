import test from "node:test";
import assert from "node:assert/strict";
import { Ringtone } from "../dist/ringtone.js";

test("audio unlock, looping, deduplication and cleanup", () => {
  const listeners = new Map();
  const sources = [];
  let context;
  const previousWindow = globalThis.window;
  const previousAudioContext = globalThis.AudioContext;
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  globalThis.AudioContext = class {
    sampleRate = 1000;
    resumes = 0;
    destination = {};
    constructor() { context = this; }
    resume() { this.resumes++; return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createBuffer(_, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      const source = { connect() {}, start() { this.started = true; }, stop() { this.stopped = true; }, disconnect() { this.disconnected = true; } };
      sources.push(source);
      return source;
    }
  };
  try {
    const ringtone = new Ringtone();
    ringtone.prepare();
    listeners.get("pointerdown")();
    assert.equal(context.resumes, 2);
    ringtone.play("incoming");
    ringtone.play("incoming");
    assert.equal(sources.length, 1);
    assert.equal(sources[0].loop, true);
    ringtone.play("outgoing");
    assert.equal(sources[0].stopped, true);
    ringtone.destroy();
    assert.equal(sources[1].stopped, true);
    assert.equal(sources[1].disconnected, true);
    assert.equal(context.closed, true);
    assert.equal(listeners.size, 0);
  } finally {
    globalThis.window = previousWindow;
    globalThis.AudioContext = previousAudioContext;
  }
});
