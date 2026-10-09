import QrScanner from "/vendor/qr-scanner.min.js";

const $ = (selector) => document.querySelector(selector);

const elements = {
  welcomeView: $("#welcomeView"),
  roomView: $("#roomView"),
  createRoomButton: $("#createRoomButton"),
  showJoinButton: $("#showJoinButton"),
  scanQrButton: $("#scanQrButton"),
  joinForm: $("#joinForm"),
  roomCodeInput: $("#roomCodeInput"),
  roomCodeDisplay: $("#roomCodeDisplay"),
  networkHint: $("#networkHint"),
  copyCodeButton: $("#copyCodeButton"),
  roomQrPanel: $("#roomQrPanel"),
  roomQrImage: $("#roomQrImage"),
  copyPairingLinkButton: $("#copyPairingLinkButton"),
  leaveButton: $("#leaveButton"),
  roomTitle: $("#roomTitle"),
  connectionBadge: $("#connectionBadge"),
  waitingPanel: $("#waitingPanel"),
  transferPanel: $("#transferPanel"),
  securityCode: $("#securityCode"),
  securityHelp: $("#securityHelp"),
  filesTab: $("#filesTab"),
  textTab: $("#textTab"),
  filesPane: $("#filesPane"),
  textPane: $("#textPane"),
  dropZone: $("#dropZone"),
  fileInput: $("#fileInput"),
  textInput: $("#textInput"),
  textCount: $("#textCount"),
  sendTextButton: $("#sendTextButton"),
  activityList: $("#activityList"),
  clearActivityButton: $("#clearActivityButton"),
  installButton: $("#installButton"),
  infoButton: $("#infoButton"),
  privacyButton: $("#privacyButton"),
  infoDialog: $("#infoDialog"),
  qrDialog: $("#qrDialog"),
  qrVideo: $("#qrVideo"),
  qrStatus: $("#qrStatus"),
  closeQrButton: $("#closeQrButton"),
  toast: $("#toast")
};

const state = {
  socket: null,
  peer: null,
  channel: null,
  roomCode: null,
  creator: false,
  config: {
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    maxFileSize: 512 * 1024 * 1024,
    turnConfigured: false
  },
  incoming: null,
  sending: false,
  downloadUrls: new Set(),
  installPrompt: null,
  toastTimer: null,
  offerSdp: "",
  answerSdp: "",
  pendingCandidates: [],
  qrScanner: null,
  qrHandled: false,
  pairingUrl: ""
};

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function formatCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function randomRoomCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function setConnectionStatus(kind, label) {
  elements.connectionBadge.className = `status-badge ${kind}`;
  elements.connectionBadge.innerHTML = "<span></span>";
  elements.connectionBadge.append(document.createTextNode(` ${label}`));
}

function openRoomView(code, creator) {
  state.roomCode = code;
  state.creator = creator;
  elements.welcomeView.classList.add("hidden");
  elements.roomView.classList.remove("hidden");
  elements.waitingPanel.classList.remove("hidden");
  elements.transferPanel.classList.add("hidden");
  elements.roomCodeDisplay.textContent = formatCode(code);
  state.pairingUrl = `${location.origin}/?room=${code}`;
  elements.roomQrPanel.classList.toggle("hidden", !creator);
  if (creator) elements.roomQrImage.src = `/api/qr?room=${encodeURIComponent(code)}`;
  else elements.roomQrImage.removeAttribute("src");
  elements.roomTitle.textContent = creator ? "Aguardando o outro aparelho" : "Entrando na conexão";
  elements.securityCode.textContent = "calculando…";
  updateNetworkHint();
  setConnectionStatus("waiting", "Aguardando");
}

function updateNetworkHint() {
  elements.networkHint.classList.toggle("ready", state.config.turnConfigured);
  elements.networkHint.innerHTML = "<span></span>";
  elements.networkHint.append(document.createTextNode(state.config.turnConfigured
    ? "Rota de contingência entre redes ativa"
    : "Conexão direta via STUN"));
}

function showConnected() {
  elements.waitingPanel.classList.add("hidden");
  elements.transferPanel.classList.remove("hidden");
  elements.roomTitle.textContent = "Ponte conectada";
  setConnectionStatus("connected", "Conectado");
  showToast("Conexão direta estabelecida");
}

function cleanupConnection(showWelcome = true) {
  if (state.channel) {
    try { state.channel.close(); } catch { /* already closed */ }
  }
  if (state.peer) {
    try { state.peer.close(); } catch { /* already closed */ }
  }
  if (state.socket) {
    try { state.socket.close(); } catch { /* already closed */ }
  }
  state.socket = null;
  state.peer = null;
  state.channel = null;
  state.roomCode = null;
  state.incoming = null;
  state.sending = false;
  state.offerSdp = "";
  state.answerSdp = "";
  state.pendingCandidates = [];
  elements.roomQrImage.removeAttribute("src");
  if (showWelcome) {
    elements.roomView.classList.add("hidden");
    elements.welcomeView.classList.remove("hidden");
  }
}

function parsePairingCode(value) {
  const raw = String(value || "").trim();
  if (/^\d{6}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.origin !== location.origin) return null;
    const room = url.searchParams.get("room") || "";
    return /^\d{6}$/.test(room) ? room : null;
  } catch {
    return null;
  }
}

function stopQrScanner() {
  if (state.qrScanner) {
    state.qrScanner.destroy();
    state.qrScanner = null;
  }
  state.qrHandled = false;
}

async function openQrScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("A câmera exige acesso por HTTPS");
    return;
  }
  elements.qrStatus.textContent = "Preparando a câmera…";
  elements.qrDialog.showModal();
  try {
    const hasCamera = await QrScanner.hasCamera();
    if (!hasCamera) throw new Error("Nenhuma câmera encontrada");
    state.qrHandled = false;
    state.qrScanner = new QrScanner(
      elements.qrVideo,
      (result) => {
        if (state.qrHandled) return;
        const code = parsePairingCode(result?.data || result);
        if (!code) {
          elements.qrStatus.textContent = "Este não é um QR Code válido do Ponte";
          return;
        }
        state.qrHandled = true;
        stopQrScanner();
        elements.qrDialog.close();
        history.replaceState({}, "", location.pathname);
        connectToRoom(code, false);
      },
      {
        preferredCamera: "environment",
        maxScansPerSecond: 10,
        returnDetailedScanResult: true
      }
    );
    await state.qrScanner.start();
    elements.qrStatus.textContent = "Centralize o QR Code dentro da moldura";
  } catch (error) {
    console.error(error);
    stopQrScanner();
    elements.qrStatus.textContent = error?.name === "NotAllowedError"
      ? "Permissão da câmera não concedida"
      : "Não foi possível iniciar a câmera";
  }
}

function sendSignal(data) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "signal", data }));
  }
}

async function connectToRoom(code, creator) {
  try { await configReady; } catch { /* STUN padrão continua disponível */ }
  cleanupConnection(false);
  openRoomView(code, creator);

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${location.host}/signal`);
  const socket = state.socket;
  let signalingQueue = Promise.resolve();

  socket.addEventListener("open", () => {
    if (socket !== state.socket) return;
    socket.send(JSON.stringify({ type: "join", room: code }));
  });

  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    // WebSocket events do not await async handlers. Keep SDP and ICE in order.
    signalingQueue = signalingQueue.then(async () => {
      if (socket !== state.socket) return;
      if (message.type === "error") {
        setConnectionStatus("error", "Erro");
        showToast(message.message || "Não foi possível conectar");
        return;
      }
      if (message.type === "peer-ready" && state.creator && !state.peer) {
        await createOffer();
        return;
      }
      if (message.type === "signal") await receiveSignal(message.data);
      if (message.type === "peer-left") {
        setConnectionStatus("error", "Desconectado");
        showToast("O outro aparelho encerrou a conexão");
        state.channel?.close();
        state.peer?.close();
        state.channel = null;
        state.peer = null;
        state.pendingCandidates = [];
        elements.transferPanel.classList.add("hidden");
        elements.waitingPanel.classList.remove("hidden");
        elements.roomTitle.textContent = "Aguardando reconexão";
      }
    }).catch(() => {
      if (socket !== state.socket) return;
      setConnectionStatus("error", "Falha no pareamento");
      showToast("Não foi possível negociar a conexão entre os aparelhos");
    });
  });

  socket.addEventListener("close", () => {
    if (socket !== state.socket) return;
    if (state.roomCode && !state.channel) setConnectionStatus("error", "Sem sinal");
  });
  socket.addEventListener("error", () => {
    if (socket !== state.socket) return;
    setConnectionStatus("error", "Erro de rede");
    showToast("Falha ao acessar o servidor de pareamento");
  });
}

function createPeer() {
  const peer = new RTCPeerConnection({ iceServers: state.config.iceServers });
  state.peer = peer;

  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) sendSignal({ kind: "candidate", candidate: event.candidate });
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "connected") showConnected();
    if (["failed", "disconnected", "closed"].includes(peer.connectionState) && state.roomCode) {
      setConnectionStatus("error", "Desconectado");
    }
  });
  peer.addEventListener("datachannel", (event) => attachDataChannel(event.channel));
  return peer;
}

async function createOffer() {
  const peer = createPeer();
  attachDataChannel(peer.createDataChannel("ponte", { ordered: true }));
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  state.offerSdp = peer.localDescription.sdp;
  sendSignal({ kind: "description", description: peer.localDescription });
}

async function receiveSignal(data) {
  try {
    if (data.kind === "description") {
      const description = data.description;
      if (description.type === "offer") {
        state.offerSdp = description.sdp;
        const peer = state.peer || createPeer();
        await peer.setRemoteDescription(description);
        await flushPendingCandidates(peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        state.answerSdp = peer.localDescription.sdp;
        sendSignal({ kind: "description", description: peer.localDescription });
        await updateSecurityCode();
      } else if (description.type === "answer" && state.peer) {
        state.answerSdp = description.sdp;
        await state.peer.setRemoteDescription(description);
        await flushPendingCandidates(state.peer);
        await updateSecurityCode();
      }
      return;
    }
    if (data.kind === "candidate" && data.candidate) {
      // ICE may arrive before the remote SDP, especially with fast desktops.
      if (!state.peer?.remoteDescription) {
        state.pendingCandidates.push(data.candidate);
      } else {
        await state.peer.addIceCandidate(data.candidate);
      }
    }
  } catch (error) {
    console.error(error);
    setConnectionStatus("error", "Falha no pareamento");
    showToast("Não foi possível criar a conexão direta");
  }
}

async function flushPendingCandidates(peer) {
  const candidates = state.pendingCandidates;
  state.pendingCandidates = [];
  for (const candidate of candidates) {
    await peer.addIceCandidate(candidate);
  }
}

async function updateSecurityCode() {
  if (!state.offerSdp || !state.answerSdp) return;
  const bytes = new TextEncoder().encode(`${state.offerSdp}\n---PONTE---\n${state.answerSdp}`);
  const digest = new Sha256().update(bytes).digest();
  elements.securityCode.textContent = Array.from(digest.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function attachDataChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 512 * 1024;
  channel.addEventListener("open", () => {
    showConnected();
    updateSecurityCode();
  });
  channel.addEventListener("message", handleChannelMessage);
  channel.addEventListener("close", () => {
    if (state.roomCode) setConnectionStatus("error", "Desconectado");
  });
  channel.addEventListener("error", () => showToast("Erro no canal de transferência"));
}

async function handleChannelMessage(event) {
  if (typeof event.data !== "string") {
    receiveFileChunk(event.data);
    return;
  }

  let message;
  try { message = JSON.parse(event.data); } catch { return; }

  if (message.type === "file-meta") beginIncomingFile(message);
  if (message.type === "file-end") await finishIncomingFile(message);
  if (message.type === "text") addReceivedText(message.text);
  if (message.type === "cancel") failIncomingFile("Envio cancelado");
}

function makeActivity({ name, detail, direction, kind = "file" }) {
  elements.activityList.querySelector(".empty-state")?.remove();
  const item = document.createElement("article");
  item.className = "activity-item";
  const top = document.createElement("div");
  top.className = "activity-top";
  const symbol = document.createElement("span");
  symbol.className = `file-symbol ${direction === "receiving" ? "receiving" : ""}`;
  symbol.innerHTML = kind === "text"
    ? '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 11h14M5 16h9"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/></svg>';
  const meta = document.createElement("span");
  meta.className = "activity-meta";
  const title = document.createElement("strong");
  title.textContent = name;
  const subtitle = document.createElement("span");
  subtitle.textContent = detail;
  meta.append(title, subtitle);
  const status = document.createElement("span");
  status.className = "activity-state";
  status.textContent = direction === "receiving" ? "Recebendo" : "Enviando";
  top.append(symbol, meta, status);
  const track = document.createElement("div");
  track.className = "progress-track";
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  track.append(bar);
  item.append(top, track);
  elements.activityList.prepend(item);
  return { item, status, bar, subtitle };
}

function setActivityProgress(activity, value, label) {
  activity.bar.style.width = `${Math.min(100, Math.max(0, value))}%`;
  if (label) activity.status.textContent = label;
}

function beginIncomingFile(message) {
  if (state.incoming) {
    failIncomingFile("Transferência interrompida");
  }
  const safeName = String(message.name || "arquivo").replace(/[\u0000-\u001f]/g, "").slice(0, 240) || "arquivo";
  const size = Number(message.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > state.config.maxFileSize) {
    state.channel?.send(JSON.stringify({ type: "cancel", id: message.id, reason: "Tamanho inválido" }));
    return;
  }
  state.incoming = {
    id: String(message.id),
    name: safeName,
    size,
    type: String(message.mime || "application/octet-stream").slice(0, 120),
    lastModified: Number(message.lastModified) || Date.now(),
    chunks: [],
    received: 0,
    hasher: new Sha256(),
    activity: makeActivity({ name: safeName, detail: formatBytes(size), direction: "receiving" })
  };
}

function receiveFileChunk(buffer) {
  const incoming = state.incoming;
  if (!incoming) return;
  const chunk = new Uint8Array(buffer);
  if (incoming.received + chunk.byteLength > incoming.size) {
    failIncomingFile("Dados excederam o tamanho informado");
    return;
  }
  incoming.chunks.push(buffer);
  incoming.hasher.update(chunk);
  incoming.received += chunk.byteLength;
  setActivityProgress(incoming.activity, incoming.size ? incoming.received / incoming.size * 100 : 100, "Recebendo");
}

async function finishIncomingFile(message) {
  const incoming = state.incoming;
  if (!incoming || String(message.id) !== incoming.id) return;
  const actualHash = incoming.hasher.hex();
  const integrityOk = incoming.received === incoming.size && timingSafeEqual(actualHash, String(message.hash || ""));
  if (!integrityOk) {
    incoming.activity.item.classList.add("error");
    incoming.activity.status.textContent = "Falhou";
    incoming.activity.subtitle.textContent = "Integridade não confirmada — arquivo descartado";
    showToast("Arquivo descartado: a verificação SHA-256 falhou");
    state.incoming = null;
    return;
  }

  const blob = new Blob(incoming.chunks, { type: incoming.type });
  const url = URL.createObjectURL(blob);
  state.downloadUrls.add(url);
  const link = document.createElement("a");
  link.className = "download-link";
  link.href = url;
  link.download = incoming.name;
  link.textContent = "Salvar arquivo verificado";
  incoming.activity.item.append(link);
  incoming.activity.item.classList.add("done");
  incoming.activity.status.textContent = "Verificado";
  incoming.activity.subtitle.textContent = `${formatBytes(incoming.size)} · SHA-256 confirmado`;
  setActivityProgress(incoming.activity, 100);
  state.incoming = null;
  showToast("Arquivo recebido e verificado");
}

function failIncomingFile(reason) {
  if (!state.incoming) return;
  state.incoming.activity.item.classList.add("error");
  state.incoming.activity.status.textContent = "Falhou";
  state.incoming.activity.subtitle.textContent = reason;
  state.incoming = null;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

async function waitForBuffer(channel) {
  if (channel.bufferedAmount <= 2 * 1024 * 1024) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Tempo limite do buffer"));
    }, 30_000);
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("Canal fechado")); };
    const cleanup = () => {
      clearTimeout(timeout);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("bufferedamountlow", onLow, { once: true });
    channel.addEventListener("close", onClose, { once: true });
  });
}

async function sendFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  if (state.channel?.readyState !== "open") return showToast("Conecte os dois aparelhos primeiro");
  if (state.sending) return showToast("Aguarde o envio atual terminar");

  state.sending = true;
  for (const file of files) {
    if (file.size > state.config.maxFileSize) {
      showToast(`${file.name} excede o limite de ${formatBytes(state.config.maxFileSize)}`);
      continue;
    }
    const id = randomId();
    const activity = makeActivity({ name: file.name, detail: formatBytes(file.size), direction: "sending" });
    try {
      state.channel.send(JSON.stringify({
        type: "file-meta",
        id,
        name: file.name,
        size: file.size,
        mime: file.type,
        lastModified: file.lastModified
      }));

      const hasher = new Sha256();
      const chunkSize = 64 * 1024;
      let offset = 0;
      while (offset < file.size) {
        const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
        hasher.update(chunk);
        await waitForBuffer(state.channel);
        state.channel.send(chunk.buffer);
        offset += chunk.byteLength;
        setActivityProgress(activity, file.size ? offset / file.size * 100 : 100, "Enviando");
      }
      state.channel.send(JSON.stringify({ type: "file-end", id, hash: hasher.hex() }));
      activity.item.classList.add("done");
      activity.status.textContent = "Enviado";
      activity.subtitle.textContent = `${formatBytes(file.size)} · resumo SHA-256 enviado`;
      setActivityProgress(activity, 100);
    } catch (error) {
      console.error(error);
      activity.item.classList.add("error");
      activity.status.textContent = "Falhou";
      activity.subtitle.textContent = "A conexão foi interrompida";
      try { state.channel?.send(JSON.stringify({ type: "cancel", id })); } catch { /* closed */ }
      break;
    }
  }
  state.sending = false;
  elements.fileInput.value = "";
}

function sendText() {
  const text = elements.textInput.value;
  if (!text.trim()) return showToast("Digite ou cole algum texto");
  if (state.channel?.readyState !== "open") return showToast("Conecte os dois aparelhos primeiro");
  state.channel.send(JSON.stringify({ type: "text", text }));
  const activity = makeActivity({ name: "Texto enviado", detail: `${text.length.toLocaleString("pt-BR")} caracteres`, direction: "sending", kind: "text" });
  activity.item.classList.add("done");
  activity.status.textContent = "Enviado";
  activity.bar.style.width = "100%";
  const preview = document.createElement("p");
  preview.className = "text-preview";
  preview.textContent = text;
  activity.item.append(preview);
  elements.textInput.value = "";
  elements.textCount.textContent = "0 caracteres";
}

function addReceivedText(textValue) {
  const text = String(textValue).slice(0, 100000);
  const activity = makeActivity({ name: "Texto recebido", detail: `${text.length.toLocaleString("pt-BR")} caracteres`, direction: "receiving", kind: "text" });
  activity.item.classList.add("done");
  activity.status.textContent = "Recebido";
  activity.bar.style.width = "100%";
  const preview = document.createElement("p");
  preview.className = "text-preview";
  preview.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-text-button";
  copy.textContent = "Copiar texto";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    showToast("Texto copiado");
  });
  activity.item.append(preview, copy);
  showToast("Novo texto recebido");
}

function selectTab(tab) {
  const files = tab === "files";
  elements.filesTab.classList.toggle("active", files);
  elements.textTab.classList.toggle("active", !files);
  elements.filesTab.setAttribute("aria-selected", String(files));
  elements.textTab.setAttribute("aria-selected", String(!files));
  elements.filesPane.classList.toggle("hidden", !files);
  elements.textPane.classList.toggle("hidden", files);
}

elements.createRoomButton.addEventListener("click", () => connectToRoom(randomRoomCode(), true));
elements.showJoinButton.addEventListener("click", () => {
  elements.joinForm.classList.toggle("hidden");
  if (!elements.joinForm.classList.contains("hidden")) elements.roomCodeInput.focus();
});
elements.scanQrButton.addEventListener("click", openQrScanner);
elements.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = elements.roomCodeInput.value.replace(/\D/g, "");
  if (code.length !== 6) return showToast("Digite os 6 dígitos do código");
  connectToRoom(code, false);
});
elements.roomCodeInput.addEventListener("input", () => {
  elements.roomCodeInput.value = elements.roomCodeInput.value.replace(/\D/g, "").slice(0, 6);
});
elements.copyCodeButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode || "");
  showToast("Código copiado");
});
elements.copyPairingLinkButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.pairingUrl);
  showToast("Link de conexão copiado");
});
elements.leaveButton.addEventListener("click", () => cleanupConnection(true));
elements.filesTab.addEventListener("click", () => selectTab("files"));
elements.textTab.addEventListener("click", () => selectTab("text"));
elements.fileInput.addEventListener("change", () => sendFiles(elements.fileInput.files));
elements.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropZone.classList.add("dragging"); });
elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragging"));
elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragging");
  sendFiles(event.dataTransfer.files);
});
elements.textInput.addEventListener("input", () => {
  elements.textCount.textContent = `${elements.textInput.value.length.toLocaleString("pt-BR")} caracteres`;
});
elements.sendTextButton.addEventListener("click", sendText);
elements.clearActivityButton.addEventListener("click", () => {
  for (const url of state.downloadUrls) URL.revokeObjectURL(url);
  state.downloadUrls.clear();
  elements.activityList.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M4 7h16v12H4zM8 4h8v3"/></svg><strong>Tudo pronto</strong><span>Seus envios e recebimentos aparecerão aqui.</span></div>';
});

for (const button of [elements.infoButton, elements.privacyButton, elements.securityHelp]) {
  button.addEventListener("click", () => elements.infoDialog.showModal());
}
elements.closeQrButton.addEventListener("click", () => elements.qrDialog.close());
elements.qrDialog.addEventListener("close", stopQrScanner);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  elements.installButton.classList.remove("hidden");
});
elements.installButton.addEventListener("click", async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  elements.installButton.classList.add("hidden");
});
window.addEventListener("appinstalled", () => showToast("Ponte instalado com sucesso"));
window.addEventListener("beforeunload", () => {
  for (const url of state.downloadUrls) URL.revokeObjectURL(url);
});

const configReady = fetch("/api/config", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error("Configuração TURN indisponível");
    return response.json();
  })
  .then((config) => {
    if (Array.isArray(config.iceServers)) state.config.iceServers = config.iceServers;
    if (Number.isSafeInteger(config.maxFileSize)) state.config.maxFileSize = config.maxFileSize;
    state.config.turnConfigured = Boolean(config.turnConfigured);
    updateNetworkHint();
  })
  .catch(() => showToast("Configuração de rede indisponível"));

const roomFromUrl = parsePairingCode(location.href);
if (roomFromUrl) {
  history.replaceState({}, "", location.pathname);
  configReady.finally(() => connectToRoom(roomFromUrl, false));
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(console.error));
}

class Sha256 {
  constructor() {
    this.state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.finished = false;
  }

  update(data) {
    if (this.finished) throw new Error("Resumo já finalizado");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bytesHashed += bytes.length;
    let position = 0;
    while (position < bytes.length) {
      const take = Math.min(bytes.length - position, 64 - this.bufferLength);
      this.buffer.set(bytes.subarray(position, position + take), this.bufferLength);
      this.bufferLength += take;
      position += take;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  }

  compress(chunk) {
    const words = new Uint32Array(64);
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_CONSTANTS[i] + words[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digest() {
    if (!this.finished) {
      const bitsHigh = Math.floor(this.bytesHashed / 0x20000000);
      const bitsLow = (this.bytesHashed << 3) >>> 0;
      this.buffer[this.bufferLength++] = 0x80;
      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength, 64);
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
      this.buffer.fill(0, this.bufferLength, 56);
      const view = new DataView(this.buffer.buffer);
      view.setUint32(56, bitsHigh, false);
      view.setUint32(60, bitsLow, false);
      this.compress(this.buffer);
      this.finished = true;
    }
    const output = new Uint8Array(32);
    const view = new DataView(output.buffer);
    this.state.forEach((word, index) => view.setUint32(index * 4, word, false));
    return output;
  }

  hex() {
    return Array.from(this.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

function rotr(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

const sha256SelfTest = new Sha256().update(new TextEncoder().encode("abc")).hex();
if (sha256SelfTest !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
  throw new Error("Falha no autoteste SHA-256");
}
