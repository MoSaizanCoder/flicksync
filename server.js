const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5, // 100 KB max signaling payload to prevent memory DoS
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ephemeral in-memory room state (wiped automatically when room becomes empty)
const roomStates = new Map();

function getRoomState(roomId) {
  if (!roomStates.has(roomId)) {
    roomStates.set(roomId, {
      passwordHash: null,
      passwordSalt: null,
      activeHostId: null,
      queue: [],
      messages: [] // [{ msgId, text, senderId, senderName }]
    });
  }
  return roomStates.get(roomId);
}

function hashPassword(plain, salt) {
  return crypto.scryptSync(String(plain), salt, 64).toString('hex');
}

function verifyPassword(plain, state) {
  if (!state.passwordHash || !state.passwordSalt) return true;
  if (typeof plain !== 'string' || plain.length === 0 || plain.length > 128) return false;
  const candidate = Buffer.from(hashPassword(plain, state.passwordSalt), 'hex');
  const stored = Buffer.from(state.passwordHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function sanitizeRoomId(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned.length >= 3 && cleaned.length <= 32 ? cleaned : null;
}

function sanitizeHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function isAuthorizedInRoom(socket, targetId = null) {
  if (!socket.authorizedRoomId) return false;
  const room = io.sockets.adapter.rooms.get(socket.authorizedRoomId);
  if (!room || !room.has(socket.id)) return false;
  if (targetId !== null && !room.has(targetId)) return false;
  return true;
}

io.on('connection', (socket) => {
  socket.authorizedRoomId = null;

  // Join room with optional password verification
  socket.on('join-room', (payload) => {
    const rawRoomId = typeof payload === 'string' ? payload : payload?.roomId;
    const providedPassword = typeof payload === 'object' ? payload?.password : '';
    const roomId = sanitizeRoomId(rawRoomId);

    if (!roomId) {
      socket.emit('join-error', { code: 'INVALID_ROOM', message: 'Invalid room ID.' });
      return;
    }

    const state = getRoomState(roomId);

    // Block unauthorized access if room is password-protected
    if (state.passwordHash) {
      if (!providedPassword) {
        socket.emit('password-required', { roomId });
        return;
      }
      if (!verifyPassword(providedPassword, state)) {
        socket.emit('password-invalid', { roomId, message: 'Incorrect room password.' });
        return;
      }
    }

    // Leave any previous room cleanly
    if (socket.authorizedRoomId && socket.authorizedRoomId !== roomId) {
      socket.leave(socket.authorizedRoomId);
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const existingUsers = room ? Array.from(room) : [];

    socket.join(roomId);
    socket.authorizedRoomId = roomId;

    socket.emit('join-success', {
      roomId,
      isPasswordLocked: Boolean(state.passwordHash)
    });
    socket.emit('all-users', existingUsers);
    socket.emit('queue-updated', {
      activeHostId: state.activeHostId,
      queue: state.queue
    });
    socket.emit('chat-updated', state.messages);
    socket.to(roomId).emit('user-joined', socket.id);
  });

  // One-time room password setup (cannot be viewed, changed, or reset once set)
  socket.on('set-room-password', ({ password }) => {
    if (!isAuthorizedInRoom(socket)) return;
    const state = getRoomState(socket.authorizedRoomId);

    if (state.passwordHash) {
      socket.emit('password-set-result', {
        ok: false,
        message: 'Password is already locked for this room and cannot be changed.'
      });
      return;
    }

    if (typeof password !== 'string' || password.trim().length < 3 || password.trim().length > 64) {
      socket.emit('password-set-result', {
        ok: false,
        message: 'Password must be between 3 and 64 characters.'
      });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    state.passwordSalt = salt;
    state.passwordHash = hashPassword(password.trim(), salt);

    // Notify everyone in room that password is now permanently locked (never send password back)
    io.to(socket.authorizedRoomId).emit('room-password-locked');
  });

  // Share clickable HTTP/HTTPS link with room members
  // Send ephemeral chat message (plain text and/or URLs) to authorized room members
  socket.on('chat-message', ({ text }) => {
    if (!isAuthorizedInRoom(socket)) return;
    if (typeof text !== 'string') return;
    const cleanText = text.trim().slice(0, 500);
    if (!cleanText) return;

    const state = getRoomState(socket.authorizedRoomId);
    state.messages.push({
      msgId: crypto.randomBytes(4).toString('hex'),
      text: cleanText,
      senderId: socket.id,
      senderName: `User (${socket.id.slice(0, 4)})`
    });

    if (state.messages.length > 50) {
      state.messages.shift();
    }

    io.to(socket.authorizedRoomId).emit('chat-updated', state.messages);
  });

  socket.on('request-cinema', () => {
    if (!isAuthorizedInRoom(socket)) return;
    socket.to(socket.authorizedRoomId).emit('request-cinema', { requesterId: socket.id });
  });

  socket.on('queue-add', (item) => {
    if (!isAuthorizedInRoom(socket) || !item) return;
    const state = getRoomState(socket.authorizedRoomId);
    const safeTitle = typeof item.title === 'string'
      ? item.title.trim().slice(0, 180)
      : 'Untitled Video';

    state.queue.push({
      queueId: String(item.queueId || '').slice(0, 24),
      title: safeTitle || 'Untitled Video',
      type: item.type === 'screen' ? 'screen' : 'file',
      ownerId: socket.id,
      ownerName: `User (${socket.id.slice(0, 4)})`
    });
    io.to(socket.authorizedRoomId).emit('queue-updated', {
      activeHostId: state.activeHostId,
      queue: state.queue
    });
  });

  socket.on('queue-remove', ({ queueId }) => {
    if (!isAuthorizedInRoom(socket)) return;
    const state = getRoomState(socket.authorizedRoomId);
    state.queue = state.queue.filter(q => q.queueId !== queueId);
    io.to(socket.authorizedRoomId).emit('queue-updated', {
      activeHostId: state.activeHostId,
      queue: state.queue
    });
  });

  socket.on('queue-play-now', ({ queueId }) => {
    if (!isAuthorizedInRoom(socket)) return;
    const state = getRoomState(socket.authorizedRoomId);
    const idx = state.queue.findIndex(q => q.queueId === queueId);
    if (idx === -1) return;

    const [selectedItem] = state.queue.splice(idx, 1);
    state.activeHostId = selectedItem.ownerId;

    io.to(socket.authorizedRoomId).emit('cinema-status', { active: false });
    io.to(socket.authorizedRoomId).emit('queue-updated', {
      activeHostId: state.activeHostId,
      queue: state.queue
    });
    io.to(selectedItem.ownerId).emit('start-queued-item', {
      queueId: selectedItem.queueId
    });
  });

  // Strict same-room WebRTC signaling relay (prevents cross-room hijacking)
  socket.on('offer', (payload) => {
    if (!payload || !isAuthorizedInRoom(socket, payload.target)) return;
    io.to(payload.target).emit('offer', {
      sdp: payload.sdp,
      caller: socket.id,
      mediaType: payload.mediaType
    });
  });

  socket.on('answer', (payload) => {
    if (!payload || !isAuthorizedInRoom(socket, payload.target)) return;
    io.to(payload.target).emit('answer', {
      sdp: payload.sdp,
      callee: socket.id,
      mediaType: payload.mediaType
    });
  });

  socket.on('ice-candidate', (payload) => {
    if (!payload || !isAuthorizedInRoom(socket, payload.target)) return;
    io.to(payload.target).emit('ice-candidate', {
      candidate: payload.candidate,
      from: socket.id,
      mediaType: payload.mediaType
    });
  });

  socket.on('cinema-status', (payload) => {
    if (!isAuthorizedInRoom(socket) || !payload) return;
    const state = getRoomState(socket.authorizedRoomId);

    if (payload.active) {
      // Only claim host if no one else is currently active
      if (state.activeHostId && state.activeHostId !== socket.id) return;
      state.activeHostId = socket.id;
    } else {
      state.activeHostId = null;
    }

    io.to(socket.authorizedRoomId).emit('cinema-status', {
      senderId: socket.id,
      active: Boolean(payload.active),
      mode: payload.mode
    });
    io.to(socket.authorizedRoomId).emit('queue-updated', {
      activeHostId: state.activeHostId,
      queue: state.queue
    });
  });

  socket.on('cinema-time', (payload) => {
    if (!isAuthorizedInRoom(socket) || !payload) return;
    const state = getRoomState(socket.authorizedRoomId);
    if (state.activeHostId !== socket.id) return;

    socket.to(socket.authorizedRoomId).emit('cinema-time', {
      currentTime: payload.currentTime,
      duration: payload.duration,
      paused: payload.paused,
      ended: payload.ended
    });
  });

  socket.on('cinema-sync', (payload) => {
    if (!isAuthorizedInRoom(socket) || !payload) return;
    socket.to(socket.authorizedRoomId).emit('cinema-sync', {
      action: payload.action,
      currentTime: payload.currentTime
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.authorizedRoomId;
    if (!roomId) return;

    const state = roomStates.get(roomId);
    if (state) {
      state.queue = state.queue.filter(q => q.ownerId !== socket.id);
      if (state.activeHostId === socket.id) {
        state.activeHostId = null;
        io.to(roomId).emit('cinema-status', { active: false });
      }
      io.to(roomId).emit('queue-updated', {
        activeHostId: state.activeHostId,
        queue: state.queue
      });

      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room || room.size === 0) {
        roomStates.delete(roomId); // Wipe password hash, queue, and links from RAM
      }
    }
    socket.to(roomId).emit('user-left', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Watch Party Server running at http://localhost:${PORT}`);
});