import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Exercise the real client handlers with delayed SDP operations. Actual WebRTC
// rejects candidates before setRemoteDescription finishes, as this mock does.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const handlers = source.slice(source.indexOf("function sendSignal(data)"), source.indexOf("async function updateSecurityCode()"));

function client() {
  const errors = [];
  const peers = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send() {}
    emit(message) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
  }
  class Peer extends EventTarget {
    remoteDescription = null;
    applied = [];
    constructor() { super(); peers.push(this); }
    async setRemoteDescription(description) {
      await new Promise((resolve) => { this.finishRemote = resolve; });
      this.remoteDescription = description;
    }
    async createAnswer() { return { type: "answer", sdp: "answer" }; }
    async createOffer() { return { type: "offer", sdp: "offer" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    createDataChannel() { return {}; }
    async addIceCandidate(candidate) {
      if (!this.remoteDescription) throw new Error("InvalidStateError: missing remote SDP");
      this.applied.push(candidate.candidate);
    }
    close() {}
  }
  const state = { config: { iceServers: [] }, peer: null, pendingCandidates: [], creator: false };
  const context = vm.createContext({
    state, configReady: Promise.resolve(), WebSocket: Socket, RTCPeerConnection: Peer,
    location: { protocol: "https:", host: "ponte.test" },
    console: { error: (error) => errors.push(error.message) },
    elements: { transferPanel: { classList: { add() {} } }, waitingPanel: { classList: { remove() {} } }, roomTitle: {} },
    cleanupConnection: () => { state.peer = null; state.pendingCandidates = []; },
    openRoomView: (code, creator) => { state.roomCode = code; state.creator = creator; },
    setConnectionStatus() {}, showToast() {}, showConnected() {},
    attachDataChannel: (channel) => { state.channel = channel; }, updateSecurityCode: async () => {}
  });
  vm.runInContext(handlers, context);
  return { state, peers, errors, connect: (creator) => context.connectToRoom("123456", creator) };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Signaling did not reach the expected state");
}

const candidate = (id) => ({ type: "signal", data: { kind: "candidate", candidate: { candidate: id } } });
const description = (type) => ({ type: "signal", data: { kind: "description", description: { type, sdp: type } } });

test("ICE received before the offer is retained without prematurely creating a peer", async () => {
  const c = client();
  await c.connect(false);
  c.state.socket.emit(candidate("early"));
  await until(() => c.state.pendingCandidates.length === 1 || c.errors.length);
  assert.equal(c.state.peer, null);
  c.state.socket.emit(description("offer"));
  await until(() => c.peers[0]?.finishRemote);
  c.peers[0].finishRemote();
  await until(() => c.peers[0].applied.length === 1);
  assert.deepEqual(c.peers[0].applied, ["early"]);
  assert.deepEqual(c.errors, []);
});

for (const creator of [false, true]) {
  test(`ICE waits for a delayed ${creator ? "answer" : "offer"} instead of being discarded`, async () => {
    const c = client();
    await c.connect(creator);
    if (creator) {
      c.state.socket.emit({ type: "peer-ready" });
      await until(() => c.peers[0]?.localDescription);
    }
    c.state.socket.emit(description(creator ? "answer" : "offer"));
    await until(() => c.peers[0]?.finishRemote);
    c.state.socket.emit(candidate("host"));
    c.state.socket.emit(candidate("relay"));
    c.peers[0].finishRemote();
    await until(() => c.peers[0].applied.length === 2 || c.errors.length);
    assert.deepEqual(c.peers[0].applied, ["host", "relay"]);
    assert.deepEqual(c.errors, []);
  });
}

test("messages from an obsolete socket do not change a new session", async () => {
  const c = client();
  await c.connect(false);
  const oldSocket = c.state.socket;
  await c.connect(false);
  oldSocket.emit(description("offer"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.peers.length, 0);
});
