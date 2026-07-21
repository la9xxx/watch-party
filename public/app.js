(function () {
  "use strict";

  // ---------- helpers ----------
  function parseYouTubeId(input) {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    const patterns = [
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = trimmed.match(p);
      if (m) return m[1];
    }
    return null;
  }

  function randomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const NAME_COLORS = ["#F5A623", "#FF5C8A", "#5FD4C4", "#8E7CFF", "#6FCF97", "#FF8A65"];
  function colorForName(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % NAME_COLORS.length;
    return NAME_COLORS[h];
  }

  // ---------- state ----------
  let socket = null;
  let myName = "";
  let roomCode = "";
  let player = null;
  let ytApiReady = false;
  let pendingVideoId = null;
  let roomState = { videoId: null, isPlaying: false, videoTime: 0, lastChangeAt: Date.now() };
  let applyingRemoteState = false;
  let lastKnownLastChangeAt = 0;

  // ---------- DOM ----------
  const el = (id) => document.getElementById(id);
  const landing = el("landing");
  const room = el("room");

  // ---------- YouTube IFrame API ----------
  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (pendingVideoId) createPlayer(pendingVideoId);
  };

let currentVideoId = null;

  function createPlayer(videoId) {
    el("emptyVideo").style.display = "none";
    el("videoFrameWrap").style.display = "block";
    el("controls").style.display = "flex";

    if (player) {
      if (videoId !== currentVideoId) {
        currentVideoId = videoId;
        player.loadVideoById(videoId);
      }
      return;
    }
   currentVideoId = videoId;
    player = new YT.Player("player", {
      videoId: videoId,
      playerVars: {
        controls: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        autoplay: 0,
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
      },
    });
  }

  function onPlayerReady() {
    syncToRoomState(true);
  }

  function onPlayerStateChange(e) {
    updatePlayPauseIcon();
  }

  function updatePlayPauseIcon() {
    if (!player || typeof player.getPlayerState !== "function") return;
    const state = player.getPlayerState();
    el("playPauseBtn").textContent = state === 1 ? "❚❚" : "▶";
  }

  function expectedTime(state) {
    if (!state.isPlaying) return state.videoTime;
    return state.videoTime + (Date.now() - state.lastChangeAt) / 1000;
  }

  function syncToRoomState(force) {
    if (!player || typeof player.seekTo !== "function") return;
    const changed = roomState.lastChangeAt !== lastKnownLastChangeAt;
    if (!changed && !force) return;
    lastKnownLastChangeAt = roomState.lastChangeAt;
    applyingRemoteState = true;
    const t = expectedTime(roomState);
    player.seekTo(t, true);
    if (roomState.isPlaying) player.playVideo();
    else player.pauseVideo();
    setTimeout(() => { applyingRemoteState = false; }, 400);
  }

  // gentle periodic drift correction using the real player clock
  setInterval(() => {
    if (!player || typeof player.getCurrentTime !== "function" ||
        !roomState.videoId) return;if (!roomState.isPlaying) return;
    const actual = player.getCurrentTime();
    const target = expectedTime(roomState);
    if (Math.abs(actual - target) > 2) {
      applyingRemoteState = true;
      player.seekTo(target, true);
      setTimeout(() => { applyingRemoteState = false; }, 400);
    }
  }, 5000);

  // update the visible time counter
  setInterval(() => {
    if (!player || typeof player.getCurrentTime !== "function") return;
    el("timeText").textContent = fmtTime(player.getCurrentTime());
  }, 500);

  // ---------- landing screen ----------
  el("joinBtn").addEventListener("click", handleJoin);
  el("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") handleJoin(); });
  el("roomInput").addEventListener("keydown", (e) => { if (e.key === "Enter") handleJoin(); });

  function handleJoin() {
    const name = el("nameInput").value.trim();
    if (!name) {
      el("joinError").textContent = "Введи имя";
      return;
    }
    myName = name;
    roomCode = el("roomInput").value.trim().toUpperCase() || randomCode();
    el("joinError").textContent = "";
    enterRoom();
  }

  // ---------- room screen ----------
  function enterRoom() {
    landing.style.display = "none";
    room.style.display = "flex";
    el("codeChip").textContent = roomCode;
    el("userName").textContent = myName;
    el("userDot").style.background = colorForName(myName);

    socket = io();
    socket.emit("join-room", { code: roomCode, name: myName });

    socket.on("state", (s) => {
      roomState = s;
      if (s.videoId) {
        if (ytApiReady) createPlayer(s.videoId);
        else pendingVideoId = s.videoId;
        syncToRoomState(false);
      }
    });

    socket.on("chat-history", (msgs) => {
      el("chatMessages").innerHTML = "";
      if (msgs.length === 0) {
        el("chatMessages").innerHTML = '<div class="chat-empty">Пока тихо. Напиши первым :)</div>';
      }
      msgs.forEach(appendChatMessage);
    });

    socket.on("chat-message", (msg) => {
      const empty = el("chatMessages").querySelector(".chat-empty");
      if (empty) empty.remove();
      appendChatMessage(msg);
    });

    socket.on("presence", ({ type, name }) => {
      const div = document.createElement("div");
      div.className = "chat-system";
      div.textContent = type === "join" ? `${name} присоединился(лась)` : `${name} вышел(ла)`;
      el("chatMessages").appendChild(div);
      el("chatMessages").scrollTop = el("chatMessages").scrollHeight;
    });
  }

  function appendChatMessage(msg) {
    const div = document.createElement("div");
    div.className = "chat-msg";
    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    nameSpan.style.color = colorForName(msg.name);
    nameSpan.textContent = msg.name;
    const textDiv = document.createElement("div");
    textDiv.className = "text";
    textDiv.textContent = msg.text;
    div.appendChild(nameSpan);
    div.appendChild(textDiv);
    el("chatMessages").appendChild(div);
    el("chatMessages").scrollTop = el("chatMessages").scrollHeight;
  }

  el("copyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(roomCode).then(() => {
      el("copyBtn").textContent = "✓";
      setTimeout(() => { el("copyBtn").textContent = "⧉"; }, 1200);
    });
  });

  el("setVideoBtn").addEventListener("click", handleSetVideo);
  el("urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") handleSetVideo(); });

  function handleSetVideo() {
    const id = parseYouTubeId(el("urlInput").value);
    if (!id) return;
    el("urlInput").value = "";
    socket.emit("set-video", { videoId: id });
  }

  el("playPauseBtn").addEventListener("click", () => {
    if (!player) return;
    const state = player.getPlayerState();
    const t = player.getCurrentTime();
    if (state === 1) {
      player.pauseVideo();
      socket.emit("play-pause", { isPlaying: false, videoTime: t });
    } else {
      player.playVideo();
      socket.emit("play-pause", { isPlaying: true, videoTime: t });
    }
  });

  el("backBtn").addEventListener("click", () => skip(-10));
  el("fwdBtn").addEventListener("click", () => skip(10));

  function skip(delta) {
    if (!player) return;
    const t = Math.max(0, player.getCurrentTime() + delta);
    const isPlaying = player.getPlayerState() === 1;
    player.seekTo(t, true);
    socket.emit("seek", { videoTime: t, isPlaying });
  }

  el("sendBtn").addEventListener("click",sendChat);
  el("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  function sendChat() {
    const text = el("chatInput").value.trim();
    if (!text) return;
    el("chatInput").value = "";
    socket.emit("chat-message", { text });
  }
})();
