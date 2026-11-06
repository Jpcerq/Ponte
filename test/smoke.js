import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const port = 44173;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    TURN_URLS: '["turn:turn.example:3478?transport=udp"]',
    TURN_SHARED_SECRET: "smoke-test-secret"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Servidor não iniciou")), 5000);
    server.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.once("exit", (code) => reject(new Error(`Servidor encerrou com código ${code}`)));
  });
}

function waitForMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Mensagem não recebida")), 3000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
    socket.once("error", reject);
  });
}

function expectRejectedOrigin() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/signal`, { origin: "https://origem-invalida.example" });
    const timeout = setTimeout(() => reject(new Error("Origem inválida não foi rejeitada")), 3000);
    socket.once("open", () => reject(new Error("Origem inválida conseguiu conectar")));
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

try {
  await waitForServer();

  const response = await fetch(`${origin}/api/config`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /object-src 'none'/);
  const config = await response.json();
  assert.ok(config.iceServers.some((server) => String(server.urls).includes("stun:")));
  const turnServer = config.iceServers.find((server) => String(server.urls).includes("turn:"));
  assert.match(turnServer.username, /^\d+:[a-f0-9]{12}$/);
  assert.ok(turnServer.credential);
  assert.doesNotMatch(JSON.stringify(config), /smoke-test-secret/);

  const appResponse = await fetch(origin);
  assert.ok(appResponse.headers.get("content-security-policy").includes(`connect-src 'self' ws://127.0.0.1:${port};`));
  const secureAppResponse = await fetch(origin, { headers: { "X-Forwarded-Proto": "https" } });
  assert.ok(secureAppResponse.headers.get("content-security-policy").includes(`connect-src 'self' wss://127.0.0.1:${port};`));

  const qrResponse = await fetch(`${origin}/api/qr?room=123456`);
  assert.equal(qrResponse.status, 200);
  assert.match(qrResponse.headers.get("content-type"), /image\/svg\+xml/);
  assert.equal(qrResponse.headers.get("x-pairing-url"), `${origin}/?room=123456`);
  assert.match(await qrResponse.text(), /<svg/);

  const vendorResponse = await fetch(`${origin}/vendor/qr-scanner.min.js`);
  assert.equal(vendorResponse.status, 200);
  assert.match(vendorResponse.headers.get("content-type"), /javascript/);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/signal`, { origin });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "join", room: "123456" }));
  const joined = await waitForMessage(socket);
  assert.deepEqual(joined, { type: "joined", peers: 0 });
  socket.close();

  await expectRejectedOrigin();

  const statuses = [];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const limitedResponse = await fetch(`${origin}/api/config`);
    await limitedResponse.text();
    statuses.push(limitedResponse.status);
  }
  assert.equal(statuses[0], 200);
  assert.equal(statuses.at(-1), 429);

  console.log("Smoke test concluído: HTTP, TURN temporário, QR, WebSocket, validação de origem e limite de configuração.");
} finally {
  server.kill();
}
