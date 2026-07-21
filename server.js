const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// In-memory room store. code -> { videoId, isPlaying, videoTime, lastChangeAt, chat: [] }
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      videoId: null,
      isPlaying: false,
      videoTime: 0,
      lastChangeAt: Date.now(),
      chat: [],
    });
  }
  return rooms.get(code);
}

// Clean up empty rooms periodically so memory doesn't grow forever
setInterval(() => {
  for (const [code, room] of rooms.entries()) {
    const socketsInRoom = io.sockets.adapter.rooms.get(code);
    if (!socketsInRoom || socketsInRoom.size === 0) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on("join-room", ({ code, name }) => {
    if (!code || !name) return;
    currentRoom = String(code).toUpperCase().slice(0, 12);
    currentName = String(name).slice(0, 24);
    socket.join(currentRoom);

    const room = getRoom(currentRoom);
    socket.emit("state", room);
    socket.emit("chat-history", room.chat);
    socket.to(currentRoom).emit("presence", { type: "join", name: currentName });
  });

  socket.on("set-video", ({ videoId }) => {
    if (!currentRoom || !videoId) return;
    const room = getRoom(currentRoom);
    room.videoId = videoId;
    room.isPlaying = true;
    room.videoTime = 0;
    room.lastChangeAt = Date.now();
    io.to(currentRoom).emit("state", room);
  });

  socket.on("play-pause", ({ isPlaying, videoTime }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.isPlaying = !!isPlaying;
    room.videoTime = Number(videoTime) || 0;
    room.lastChangeAt = Date.now();
    io.to(currentRoom).emit("state", room);
  });

  socket.on("seek", ({ videoTime, isPlaying }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.videoTime = Number(videoTime) || 0;
    room.isPlaying = !!isPlaying;
    room.lastChangeAt = Date.now();
    io.to(currentRoom).emit("state", room);
  });

  socket.on("chat-message", ({ text }) => {
    if (!currentRoom || !currentName || !text) return;
    const room = getRoom(currentRoom);
    const msg = { name: currentName, text: String(text).slice(0, 500), ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.shift();
    io.to(currentRoom).emit("chat-message", msg);
  });

  socket.on("disconnect", () => {
    if (currentRoom && currentName) {
      socket.to(currentRoom).emit("presence", { type: "leave", name: currentName });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Watch Party server listening on port ${PORT}`);
});
