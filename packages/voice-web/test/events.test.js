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
function incomingCall(callId, sid) {
  const call = new EventEmitter();
  let status = "pending";
  call.status = () => status;
  call.parameters = { CallSid: sid, From: "+33100000002" };
  call.customParameters = new Map([["CallId", callId]]);
  call.reject = () => { status = "closed"; call.rejected = true; call.emit("reject"); };
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

test("connected events include the provider SID when the SDK supplies it", async () => {
  const sid = `CA${"1".repeat(32)}`;
  for (const status of ["connecting", "open"]) {
    const call = sdkCall(status);
    if (status === "open") call.parameters = { CallSid: sid };
    const { client, events } = setup(async () => call);
    await client.startCall(target);
    if (status === "connecting") {
      call.parameters = { CallSid: sid };
      call.emit("accept");
    }
    assert.deepEqual(events.at(-1), { type: "active", providerCallSid: sid });
  }
});

test("rejecting an inbound call dismisses queued and late invites for the same call", () => {
  const first = incomingCall("business-call-1", "CA1");
  const queued = incomingCall("business-call-1", "CA2");
  const queuedAgain = incomingCall("business-call-1", "CA3");
  const late = incomingCall("business-call-1", "CA4");
  const fresh = incomingCall("business-call-2", "CA5");
  const { client, events } = setup(async () => first);
  client.device.calls = [first, queued, queuedAgain];
  for (const call of client.device.calls) {
    const reject = call.reject;
    call.reject = () => {
      reject();
      client.device.calls.splice(client.device.calls.indexOf(call), 1);
    };
  }

  client.handleIncoming(first);
  client.rejectCall();
  client.handleIncoming(late);
  client.handleIncoming(fresh);

  assert.equal(first.rejected, true);
  assert.equal(queued.rejected, true);
  assert.equal(queuedAgain.rejected, true);
  assert.equal(late.rejected, true);
  assert.equal(fresh.rejected, undefined);
  assert.deepEqual(events.map(event => event.type), ["incoming", "ended", "incoming"]);
});

test("a cancelled invite emitted late by the SDK is never shown again", () => {
  const call = incomingCall("business-call-1", "CA1");
  const { client, events } = setup(async () => call);
  call.reject();
  client.handleIncoming(call);
  assert.deepEqual(events, []);
});

test("a second incoming call cannot replace the one displayed", () => {
  const visible = incomingCall("business-call-1", "CA1");
  const hidden = incomingCall("business-call-2", "CA2");
  const { client, events } = setup(async () => visible);
  client.handleIncoming(visible);
  client.handleIncoming(visible);
  client.handleIncoming(hidden);
  assert.equal(hidden.rejected, true);
  assert.equal(visible.rejected, undefined);
  assert.deepEqual(events.map(event => event.type), ["incoming"]);
});
