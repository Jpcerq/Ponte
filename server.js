import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin"
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function parseList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function withoutBlockedBrowserPorts(servers) {
  return servers.map((server) => ({
    ...server,
    urls: (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url) => !String(url).includes(":53?"))
  })).filter((server) => server.urls.length);
}

async function createIceConfig() {
  const cloudflareKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const cloudflareToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (cloudflareKeyId && cloudflareToken) {
    const requestedTtl = Number(process.env.TURN_TTL_SECONDS || 3600);
    const ttl = Math.min(172800, Math.max(300, Number.isFinite(requestedTtl) ? requestedTtl : 3600));
    const turnResponse = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cloudflareKeyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudflareToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ttl })
      }
    );
    if (!turnResponse.ok) throw new Error(`Cloudflare TURN respondeu ${turnResponse.status}`);
    const turnConfig = await turnResponse.json();
    if (!Array.isArray(turnConfig.iceServers)) throw new Error("Resposta TURN invalida");
    return {
      iceServers: withoutBlockedBrowserPorts(turnConfig.iceServers),
      turnConfigured: true,
      turnProvider: "cloudflare"
    };
  }

  const iceServers = [];
  const stunUrls = parseList(process.env.STUN_URLS || "stun:stun.cloudflare.com:3478");
  if (stunUrls.length) iceServers.push({ urls: stunUrls });

  if (process.env.ICE_SERVERS_JSON) {
    const configured = JSON.parse(process.env.ICE_SERVERS_JSON);
    if (!Array.isArray(configured)) throw new Error("ICE_SERVERS_JSON invalido");
    iceServers.push(...configured);
  }

  const turnUrls = parseList(process.env.TURN_URLS);
  const turnSecret = process.env.TURN_SHARED_SECRET;
  if (turnUrls.length && turnSecret) {
    const requestedTtl = Number(process.env.TURN_TTL_SECONDS || 3600);
    const ttl = Math.min(86400, Math.max(300, Number.isFinite(requestedTtl) ? requestedTtl : 3600));
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${randomBytes(6).toString("hex")}`;
    const credential = createHmac("sha1", turnSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }
  return {
    iceServers,
    turnConfigured: iceServers.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => String(url).startsWith("turn"))),
    turnProvider: turnUrls.length && turnSecret ? "coturn" : "stun-only"
  };
}

function getPublicOrigin(request) {
  if (process.env.PUBLIC_URL) return new URL(process.env.PUBLIC_URL).origin;
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  return `${protocol}://${request.headers.host || `localhost:${port}`}`;
}

function getClientIp(request) {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      return sendJson(response, 200, { status: "ok" });
    }

    if (url.pathname === "/api/config") {
      if (process.env.ICE_SERVERS_JSON) {
        try {
          JSON.parse(process.env.ICE_SERVERS_JSON);
        } catch {
          return sendJson(response, 500, { error: "ICE_SERVERS_JSON invalido" });
        }
      }
      try {
        const iceConfig = await createIceConfig();
        return sendJson(response, 200, { ...iceConfig, maxFileSize: 536870912 });
      } catch (error) {
        console.error("Falha ao gerar configuracao ICE:", error.message);
        return sendJson(response, 503, { error: "Configuracao TURN indisponivel" });
      }
    }

    if (url.pathname === "/api/qr") {
      const roomCode = String(url.searchParams.get("room") || "");
      if (!/^\d{6}$/.test(roomCode)) return sendJson(response, 400, { error: "Codigo invalido" });
      const pairingUrl = `${getPublicOrigin(request)}/?room=${roomCode}`;
      const svg = await QRCode.toString(pairingUrl, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        color: { dark: "#173f36", light: "#fffefa" }
      });
      response.writeHead(200, {
        ...securityHeaders,
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Pairing-URL": pairingUrl
      });
      return response.end(svg);
    }

    const vendorFiles = {
      "/vendor/qr-scanner.min.js": join(root, "..", "node_modules", "qr-scanner", "qr-scanner.min.js"),
      "/vendor/qr-scanner-worker.min.js": join(root, "..", "node_modules", "qr-scanner", "qr-scanner-worker.min.js")
    };
    if (vendorFiles[url.pathname]) {
      const body = await readFile(vendorFiles[url.pathname]);
      response.writeHead(200, {
        ...securityHeaders,
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "public, max-age=86400"
      });
      return response.end(body);
    }

    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(root, safePath);

    if (!filePath.startsWith(root)) {
      response.writeHead(403, securityHeaders);
      return response.end("Forbidden");
    }

    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    const cacheControl = requestedPath === "/index.html" || extension === ".js"
      ? "no-cache"
      : "public, max-age=86400";
    // Some browsers do not include WebSocket schemes in connect-src 'self'.
    const socketOrigin = new URL(getPublicOrigin(request));
    socketOrigin.protocol = socketOrigin.protocol === "https:" ? "wss:" : "ws:";
    const contentSecurityPolicy = securityHeaders["Content-Security-Policy"].replace(
      "connect-src 'self';",
      `connect-src 'self' ${socketOrigin.origin};`
    );

    response.writeHead(200, {
      ...securityHeaders,
      "Content-Security-Policy": contentSecurityPolicy,
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": cacheControl
    });
    response.end(body);
  } catch {
    response.writeHead(404, { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Nao encontrado");
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
const rooms = new Map();
const joinAttempts = new Map();
const ROOM_TTL_MS = 15 * 60 * 1000;

function transmit(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function leaveRoom(socket) {
  const roomCode = socket.roomCode;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  room.delete(socket);
  socket.roomCode = null;
  for (const peer of room) transmit(peer, { type: "peer-left" });
  if (room.size === 0) rooms.delete(roomCode);
}

sockets.on("connection", (socket) => {
  socket.isAlive = true;
  socket.messageCount = 0;
  socket.rateWindow = Date.now();

  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (raw) => {
    const now = Date.now();
    if (now - socket.rateWindow > 10_000) {
      socket.rateWindow = now;
      socket.messageCount = 0;
    }
    socket.messageCount += 1;
    if (socket.messageCount > 200) return socket.close(1008, "Limite excedido");

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return transmit(socket, { type: "error", message: "Mensagem invalida" });
    }

    if (message.type === "join") {
      const ip = socket.clientIp || "unknown";
      const attempt = joinAttempts.get(ip) || { count: 0, startedAt: now };
      if (now - attempt.startedAt > 60_000) {
        attempt.count = 0;
        attempt.startedAt = now;
      }
      attempt.count += 1;
      joinAttempts.set(ip, attempt);
      if (attempt.count > 12) return transmit(socket, { type: "error", message: "Muitas tentativas. Aguarde um minuto." });

      leaveRoom(socket);
      const roomCode = String(message.room || "").replace(/\D/g, "").slice(0, 6);
      if (roomCode.length !== 6) return transmit(socket, { type: "error", message: "Codigo invalido" });

      const room = rooms.get(roomCode) || new Set();
      if (room.size >= 2) return transmit(socket, { type: "error", message: "Esta sala ja esta cheia" });
      room.add(socket);
      rooms.set(roomCode, room);
      socket.roomCode = roomCode;
      socket.joinedAt = now;
      transmit(socket, { type: "joined", peers: room.size - 1 });
      if (room.size === 2) for (const peer of room) transmit(peer, { type: "peer-ready" });
      return;
    }

    if (message.type === "signal" && socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (!room) return;
      for (const peer of room) {
        if (peer !== socket) transmit(peer, { type: "signal", data: message.data });
      }
    }
  });

  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/signal") return socket.destroy();
  try {
    const origin = new URL(request.headers.origin || "");
    if (origin.host !== request.headers.host) return socket.destroy();
  } catch {
    return socket.destroy();
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSocket.clientIp = getClientIp(request);
    sockets.emit("connection", webSocket, request);
  });
});

const heartbeat = setInterval(() => {
  for (const socket of sockets.clients) {
    if (!socket.isAlive) {
      leaveRoom(socket);
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  const now = Date.now();
  for (const [roomCode, room] of rooms) {
    const oldestJoin = Math.min(...Array.from(room, (socket) => socket.joinedAt || now));
    if (now - oldestJoin > ROOM_TTL_MS) {
      for (const socket of room) socket.close(1000, "Sala expirada");
      rooms.delete(roomCode);
    }
  }
  for (const [ip, attempt] of joinAttempts) {
    if (now - attempt.startedAt > 2 * 60_000) joinAttempts.delete(ip);
  }
}, 30_000);

server.on("close", () => clearInterval(heartbeat));
server.listen(port, host, () => {
  console.log(`Ponte disponivel em http://localhost:${port}`);
});
