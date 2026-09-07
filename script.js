console.log("script.js loaded");

const BACKEND_URL = "https://hexinema-backend.onrender.com";
const WS_URL = BACKEND_URL.replace(/^http/, 'ws');

let username = sessionStorage.getItem("username");

const overlay = document.getElementById("nameOverlay");
const nameInput = document.getElementById("nameInput");
const nameBtn = document.getElementById("nameBtn");

let ws;
let isRemoteUpdate = false;
let wsHeartbeat;
let pongTimeout = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let isReconnecting = false;
let lastStatusMessage = "";

function addStatusMessage(text, color = "gray") {
  // Suppress duplicate consecutive status messages
  if (text === lastStatusMessage) return;
  lastStatusMessage = text;

  const msg = document.createElement("div");
  msg.style.color = color;
  msg.style.fontSize = "0.8em";
  msg.style.fontStyle = "italic";
  msg.innerHTML = `[System] ${text}`;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}

const clientId = Math.random().toString(36).slice(2);
const roomId = new URLSearchParams(window.location.search).get("room");

let roomMediaType = "local";
let roomMediaSource = null;
let isHost = false;
let pendingSync = null;

const mobileChatToggle = document.getElementById("mobileChatToggle");
const chatPanel = document.getElementById("chatPanel");
const appEl = document.getElementById("app");
if (mobileChatToggle && chatPanel) {
  mobileChatToggle.onclick = () => {
    const isLandscape = window.matchMedia("(orientation: landscape)").matches;
    if (isLandscape) {
      chatPanel.classList.remove("mobile-hidden");
      chatPanel.classList.toggle("mobile-open");
      chatPanel.classList.toggle("mobile-visible");
    } else {
      chatPanel.classList.remove("mobile-open");
      chatPanel.classList.remove("mobile-visible");
      chatPanel.classList.toggle("mobile-hidden");
      if (appEl) appEl.classList.toggle("chat-collapsed");
    }
  };
}

const video = document.getElementById("video");
const videoSource = document.getElementById("videoSource");
const youtubeContainer = document.getElementById("youtubeContainer");
let ytPlayer = null;
let isYtReady = false;
const screenVideo = document.getElementById("screenVideo");
const startScreenShareBtn = document.getElementById("startScreenShareBtn");
let peerConnections = {};
let localStream = null;

const videoNameEl = document.getElementById("videoName");
const userCountEl = document.getElementById("userCount");
const messages = document.getElementById("messages");
const input = document.getElementById("msgInput");

async function loadRoomVideo() {
  try {
    const response = await fetch(`${BACKEND_URL}/room-info/${roomId}`);
    const data = await response.json();
    if (!data.media_type) return;

    roomMediaType = data.media_type;
    roomMediaSource = data.media_source;

    if (roomMediaType === "local") {
      video.style.display = "block";
      video.src = `${BACKEND_URL}/video/${encodeURIComponent(roomMediaSource)}`;
      videoNameEl.textContent = roomMediaSource;
    } else if (roomMediaType === "youtube") {
      youtubeContainer.style.display = "block";
      videoNameEl.textContent = "YouTube Video";
      initYoutube();
    } else if (roomMediaType === "screen") {
      screenVideo.style.display = "block";
      videoNameEl.textContent = "Screen Share";
    }

  } catch {
    alert("Failed to load room info");
  }
}

function initYoutube() {
  if (window.YT && window.YT.Player) {
    createYtPlayer();
  } else {

    const checkYT = setInterval(() => {
      if (window.YT && window.YT.Player) {
        clearInterval(checkYT);
        createYtPlayer();
      }
    }, 100);
  }
}

function createYtPlayer() {
  ytPlayer = new YT.Player('youtubePlayer', {
    height: '100%',
    width: '100%',
    videoId: roomMediaSource,
    playerVars: {
      'playsinline': 1,
      'controls': 1
    },
    events: {
      'onReady': onYtPlayerReady,
      'onStateChange': onYtPlayerStateChange
    }
  });
}

function onYtPlayerReady(event) {
  isYtReady = true;
  if (pendingSync) {
    const s = pendingSync;
    pendingSync = null;
    isRemoteUpdate = true;
    if (Math.abs(ytPlayer.getCurrentTime() - s.time) > 0.4) {
      ytPlayer.seekTo(s.time, true);
    }
    if (s.is_playing) ytPlayer.playVideo();
    else ytPlayer.pauseVideo();
    setTimeout(() => { isRemoteUpdate = false; }, 250);
  }
}

function onYtPlayerStateChange(event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isRemoteUpdate) return;

  if (event.data === YT.PlayerState.PLAYING) {
    sendSync(true, ytPlayer.getCurrentTime());
  } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
    sendSync(false, ytPlayer.getCurrentTime());
  }
}

if (username) {
  overlay.style.display = "none";
  loadRoomVideo().then(() => {
    initializeWebSocket();
  });
}

nameBtn.onclick = () => {
  const value = nameInput.value.trim();
  if (!value) return;

  username = value;
  sessionStorage.setItem("username", username);
  overlay.style.display = "none";
  loadRoomVideo().then(() => {
    initializeWebSocket();
  });
};

function initializeWebSocket() {
  // Guard against multiple concurrent reconnection attempts
  if (isReconnecting) return;
  isReconnecting = true;

  console.log("Connecting to WebSocket:", `${WS_URL}/ws/${roomId}`);
  ws = new WebSocket(`${WS_URL}/ws/${roomId}`);

  ws.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error("Invalid JSON from server:", event.data);
      return;
    }

    // Handle room-expired error
    if (data.type === "error" && data.message === "room_not_found") {
      addStatusMessage("This room has expired. Please create a new room.", "#f44336");
      if (wsHeartbeat) clearInterval(wsHeartbeat);
      if (pongTimeout) clearTimeout(pongTimeout);
      isReconnecting = false;
      return;
    }

    if (data.type === "role") {
      isHost = data.role === "host";
      if (isHost && roomMediaType === "screen") {
        startScreenShareBtn.style.display = "block";
      }
      return;
    }

    if (data.type === "count") {
      const n = data.count;
      userCountEl.textContent = n === 1 ? "1 person" : n + " people";
      return;
    }

    if (data.action === "sync") {
      if (data.clientId === clientId) return;

      isRemoteUpdate = true;

      if (roomMediaType === "local") {
        if (Math.abs(video.currentTime - data.time) > 0.4) {
          video.currentTime = data.time;
        }
        if (data.is_playing && video.paused) video.play();
        if (!data.is_playing && !video.paused) video.pause();
      } else if (roomMediaType === "youtube") {
        if (isYtReady) {
          if (Math.abs(ytPlayer.getCurrentTime() - data.time) > 0.4) {
            ytPlayer.seekTo(data.time, true);
          }
          if (data.is_playing) ytPlayer.playVideo();
          else ytPlayer.pauseVideo();
        } else {
          pendingSync = { is_playing: data.is_playing, time: data.time };
        }
      }

      setTimeout(() => { isRemoteUpdate = false; }, 250);
    }

    if (data.action === "webrtc_offer") {
      if (data.targetId !== clientId) return;
      handleOffer(data.offer, data.senderId);
    }
    if (data.action === "webrtc_answer") {
      if (data.targetId !== clientId) return;
      handleAnswer(data.answer, data.senderId);
    }
    if (data.action === "webrtc_ice") {
      if (data.targetId !== clientId) return;
      handleIceCandidate(data.candidate, data.senderId);
    }
    if (data.action === "request_stream") {
      if (isHost && roomMediaType === "screen" && localStream) {
        createPeerConnection(data.clientId);
      }
    }

    if (data.action === "request_sync") {
      if (isHost) {
        let currentTime = 0;
        let isPlaying = false;
        if (roomMediaType === "local") {
          currentTime = video.currentTime;
          isPlaying = !video.paused;
        } else if (roomMediaType === "youtube" && isYtReady) {
          currentTime = ytPlayer.getCurrentTime();
          isPlaying = ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
        }
        sendSync(isPlaying, currentTime);
      }
      return;
    }

    if (data.action === "stream_ready") {
      if (!isHost && roomMediaType === "screen") {
        ws.send(JSON.stringify({ action: "request_stream", clientId }));
      }
    }

    // Server-side keepalive acknowledgment
    if (data.action === "server_ping") return;

    if (data.action === "pong") {
      // Clear pong timeout — connection is alive
      if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
      }
      return;
    }

    if (data.chat) {
      messages.innerHTML += `<div><b>${data.user}:</b> ${data.chat}</div>`;
      messages.scrollTop = messages.scrollHeight;
    }
  };

  ws.onopen = () => {
    console.log("WebSocket connected!");
    addStatusMessage("Connected to server.", "#4caf50");

    // Reset reconnection state on successful connection
    isReconnecting = false;
    reconnectDelay = 1000;

    if (wsHeartbeat) clearInterval(wsHeartbeat);
    wsHeartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "ping" }));

        // Set pong timeout — if no pong in 5s, connection is dead
        if (pongTimeout) clearTimeout(pongTimeout);
        pongTimeout = setTimeout(() => {
          console.warn("Pong timeout — closing stale connection");
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }, 5000);
      }
    }, 25000);

    if (!isHost && roomMediaType === "screen") {
      setTimeout(() => {
        ws.send(JSON.stringify({ action: "request_stream", clientId }));
      }, 500);
    }
  };

  ws.onerror = (err) => {
    console.error("WebSocket Error:", err);
    addStatusMessage("Connection error. Is the backend running?", "#f44336");
  };

  ws.onclose = () => {
    console.log("WebSocket closed.");
    addStatusMessage("Disconnected from server. Reconnecting...", "#ff9800");
    if (wsHeartbeat) clearInterval(wsHeartbeat);
    if (pongTimeout) clearTimeout(pongTimeout);
    isReconnecting = false;

    // Exponential backoff: 1s → 2s → 4s → ... → 30s max
    setTimeout(() => {
      initializeWebSocket();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };
}

function sendSync(isPlaying, time) {
  ws.send(JSON.stringify({
    action: "sync",
    is_playing: isPlaying,
    time: time,
    clientId
  }));
}

video.onplay = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isRemoteUpdate) return;
  sendSync(true, video.currentTime);
};

video.onpause = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isRemoteUpdate) return;
  sendSync(false, video.currentTime);
};

video.onseeked = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isRemoteUpdate) return;
  sendSync(!video.paused, video.currentTime);
};

startScreenShareBtn.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    screenVideo.srcObject = localStream;
    startScreenShareBtn.style.display = "none";

    ws.send(JSON.stringify({ action: "stream_ready", senderId: clientId }));
  } catch (err) {
    console.error("Error getting display media.", err);
  }
};

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function createPeerConnection(targetId) {
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[targetId] = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        action: "webrtc_ice",
        targetId: targetId,
        senderId: clientId,
        candidate: event.candidate
      }));
    }
  };

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    action: "webrtc_offer",
    targetId: targetId,
    senderId: clientId,
    offer: offer
  }));
}

async function handleOffer(offer, senderId) {
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[senderId] = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        action: "webrtc_ice",
        targetId: senderId,
        senderId: clientId,
        candidate: event.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    if (screenVideo.srcObject !== event.streams[0]) {
      screenVideo.srcObject = event.streams[0];
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(JSON.stringify({
    action: "webrtc_answer",
    targetId: senderId,
    senderId: clientId,
    answer: answer
  }));
}

async function handleAnswer(answer, senderId) {
  const pc = peerConnections[senderId];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
}

async function handleIceCandidate(candidate, senderId) {
  const pc = peerConnections[senderId];
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

function sendMessage() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const msg = input.value.trim();
  if (!msg) return;

  messages.innerHTML += `<div><b>You:</b> ${msg}</div>`;
  messages.scrollTop = messages.scrollHeight;

  ws.send(JSON.stringify({
    chat: msg,
    user: username
  }));

  input.value = "";
}

if (input) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      sendMessage();
    }
  });
}

const inviteBtn = document.getElementById("inviteBtn");
const inviteContainer = document.getElementById("inviteContainer");
const inviteMenu = document.getElementById("inviteMenu");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const copyCodeBtn = document.getElementById("copyCodeBtn");

if (inviteBtn) {
  inviteBtn.onclick = () => {
    inviteMenu.style.display =
      inviteMenu.style.display === "flex" ? "none" : "flex";
  };
}

if (copyLinkBtn) {
  copyLinkBtn.onclick = () => {
    const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(link);
    inviteMenu.style.display = "none";
  };
}

if (copyCodeBtn) {
  copyCodeBtn.onclick = () => {
    navigator.clipboard.writeText(roomId);
    inviteMenu.style.display = "none";
  };
}

document.addEventListener("click", (e) => {
  if (inviteContainer && !inviteContainer.contains(e.target)) {
    inviteMenu.style.display = "none";
  }
});
