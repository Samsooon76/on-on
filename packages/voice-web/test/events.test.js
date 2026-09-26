import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TwilioWebVoiceClient } from "../dist/index.js";

function sdkCall(status = "connecting") {
  const call = new EventEmitter();
  call.status = () => status;
  call.disconnect = () => { call.disconnected = true; call.emit("disconnect"); };
  return call;
}
function setup(connect) {
  const client = new TwilioWebVoiceClient(), events = [];
  // SDK boundary only; production always constructs the real Twilio Device.
  client.device = { state: "registered", connect, disconnectAll() {}, removeAllListeners() {}, destroy() {} };
  client.subscribe(event => events.push(event));
  return { client, events };
}
const target = { destination: "+33100000001", intentId: "intent" };

test("ringing and connection are reported only when the SDK confirms them", async () => {
  const call = sdkCall(); const { client, events } = setup(async () => call);
  await client.startCall(target);
  assert.deepEqual(events, [{ type: "connecting" }]);
  call.emit("ringing"); call.emit("accept"); call.emit("reconnecting"); call.emit("reconnected");
  assert.deepEqual(events.map(e => e.type), ["connecting", "ringing", "active", "reconnecting", "reconnected"]);
});
test("duplicate and late events cannot end or change the next call", async () => {
  const first = sdkCall(), second = sdkCall(); let call = first;
  const { client, events } = setup(async () => call);
  await client.startCall(target); first.emit("error", new Error("failed")); first.emit("disconnect");
  call = second; await client.startCall(target); first.emit("accept"); first.emit("disconnect");
  assert.equal(events.filter(e => e.type === "ended").length, 1);
  assert.equal(events.filter(e => e.type === "active").length, 0);
  second.emit("disconnect"); assert.equal(events.filter(e => e.type === "ended").length, 2);
});
test("canceling during asynchronous setup disconnects the late SDK call", async () => {
  let resolve; const { client } = setup(() => new Promise(done => { resolve = done; }));
  const pending = client.startCall(target); client.hangUp(); const call = sdkCall(); resolve(call);
  await assert.rejects(pending, /annulée/); assert.equal(call.disconnected, true);
});
test("an already-open SDK call is immediately shown as connected", async () => {
  const { client, events } = setup(async () => sdkCall("open")); await client.startCall(target);
  assert.deepEqual(events.map(e => e.type), ["connecting", "active"]);
});
