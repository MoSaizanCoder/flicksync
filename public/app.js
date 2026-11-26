/* =========================================================
   FlickSync — Main Client Application Logic
   ========================================================= */
const socket = io({ autoConnect: false });

const TAB_CLIENT_ID = sessionStorage.getItem('flicksync_tab_id') ||
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());
sessionStorage.setItem('flicksync_tab_id', TAB_CLIENT_ID);

const pathParts = window.location.pathname.split('/');
const urlRoomId = pathParts[1] === 'room' && pathParts[2]
  ? pathParts[2].replace(/[^a-zA-Z0-9_-]/g, '')
  : '';
let roomId = urlRoomId.length >= 3 ? urlRoomId : null;
if (roomId) {
  document.getElementById('roomBadge').textContent = `Room: ${roomId}`;
}

document.body.classList.add('in-lobby');

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

const callPeers = {};
const cinemaPeers = {};
const remoteCallVideos = {};
const iceCandidateQueues = { call: {}, cinema: {} };
let knownPeers = new Set();
const peerDisplayNames = {};

let isRoomAuthorized = false;
let isPasswordLocked = false;
let mediaInitialized = false;

let localCallStream = null;
let localCinemaStream = null;
let isHostingCinema = false;
let roomActiveHostId = null;
let currentCinemaMode = null;
let currentObjectUrl = null;
let isRemoteSyncing = false;
let isDraggingSlider = false;
let isRemotePaused = false;
let didVideoEnd = false;
let focusedCameraPeerId = null;

const localQueuedFiles = new Map();

const PROFILE_NAME_KEY = 'flicksync_profile_name';
let profileName = (localStorage.getItem(PROFILE_NAME_KEY) || '').trim();

function syncProfileBadge() {
  const labelEl = document.getElementById('localCamLabel');
  if (labelEl) {
    labelEl.textContent = profileName ? `${profileName} (You)` : 'You';
  }
}

const MOOD_THEME_KEY = 'flicksync_mood_theme';
const ALLOWED_THEMES = new Set(['default', 'romantic', 'scifi', 'comedy']);
const moodThemeSelect = document.getElementById('moodThemeSelect');

function applyMoodTheme(themeName) {
  const safeTheme = ALLOWED_THEMES.has(themeName) ? themeName : 'default';
  if (safeTheme === 'default') {
    document.body.removeAttribute('data-theme');
  } else {
    document.body.setAttribute('data-theme', safeTheme);
  }
  if (moodThemeSelect) {
    moodThemeSelect.value = safeTheme;
  }
  localStorage.setItem(MOOD_THEME_KEY, safeTheme);

  if (window.FlickSyncFloatingPiP && window.FlickSyncFloatingPiP.syncTheme) {
    window.FlickSyncFloatingPiP.syncTheme(safeTheme);
  }
}

applyMoodTheme(localStorage.getItem(MOOD_THEME_KEY) || 'default');

if (moodThemeSelect) {
  moodThemeSelect.addEventListener('change', (e) => {
    applyMoodTheme(e.target.value);
  });
}

if (window.FlickSyncFloatingPiP) {
  window.FlickSyncFloatingPiP.init({
    getLocalCallStream: () => localCallStream,
    getRemoteCallVideos: () => remoteCallVideos,
    getPeerDisplayNames: () => peerDisplayNames,
    getProfileName: () => profileName,
    showToast,
    onStopShare: () => socket.emit('cinema-status', { active: false })
  });
}

const initialLobbyNameInput = document.getElementById('lobbyNameInput');
const initialLobbyRoomInput = document.getElementById('lobbyRoomIdInput');
if (initialLobbyNameInput) initialLobbyNameInput.value = profileName;
if (initialLobbyRoomInput && roomId) initialLobbyRoomInput.value = roomId;
syncProfileBadge();

function stopCameraAndMicCompletely() {
  if (localCallStream) {
    localCallStream.getTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
    localCallStream = null;
  }
  const localCamEl = document.getElementById('localCamVideo');
  if (localCamEl && localCamEl.srcObject) {
    localCamEl.srcObject.getTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
    localCamEl.srcObject = null;
  }
  Object.values(callPeers).forEach((pc) => {
    pc.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.enabled = false;
        sender.track.stop();
      }
    });
    pc.close();
  });
  for (const k in callPeers) delete callPeers[k];

  pendingCallUsers = [];
  mediaInitPromise = null;
  mediaInitialized = false;
}

function leaveCurrentRoomToLobby(prefillRoomId = '') {
  if (window.FlickSyncFloatingPiP) window.FlickSyncFloatingPiP.close();
  if (document.body.classList.contains('theater-fullscreen')) {
    toggleTheaterFullscreen(false);
  }
  focusedCameraPeerId = null;
  cleanupLocalCinemaUI();
  stopCameraAndMicCompletely();

  for (const id of Object.keys(remoteCallVideos)) {
    const tile = document.getElementById(`tile-${id}`);
    if (tile) tile.remove();
    delete remoteCallVideos[id];
  }
  knownPeers.clear();
  for (const k in peerDisplayNames) delete peerDisplayNames[k];
  updatePeerBadge();

  isRoomAuthorized = false;
  roomActiveHostId = null;
  roomId = null;
  if (socket.connected) {
    socket.disconnect();
  }

  const nameInput = document.getElementById('lobbyNameInput');
  const roomInput = document.getElementById('lobbyRoomIdInput');
  const errEl = document.getElementById('lobbyErrorText');
  if (nameInput) nameInput.value = profileName;
  if (roomInput) roomInput.value = prefillRoomId;
  if (errEl) errEl.classList.add('hidden');

  if (!prefillRoomId) {
    window.history.replaceState({}, '', '/');
  }
  document.body.classList.add('in-lobby');
}

function enterRoomFromLobby(targetRoomId) {
  const cleaned = String(targetRoomId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const errEl = document.getElementById('lobbyErrorText');
  if (cleaned.length < 3 || cleaned.length > 32) {
    if (errEl) {
      errEl.textContent = 'Room ID must be 3–32 letters, numbers, - or _.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (errEl) errEl.classList.add('hidden');

  const nameInput = document.getElementById('lobbyNameInput');
  profileName = (nameInput ? nameInput.value : profileName).trim().slice(0, 32);
  localStorage.setItem(PROFILE_NAME_KEY, profileName);
  syncProfileBadge();

  roomId = cleaned;
  document.getElementById('roomBadge').textContent = `Room: ${roomId}`;
  window.history.replaceState({}, '', `/room/${roomId}`);
  document.body.classList.remove('in-lobby');

  if (socket.connected) {
    socket.emit('join-room', { roomId, displayName: profileName, clientId: TAB_CLIENT_ID });
  } else {
    socket.connect();
  }
}

document.getElementById('leaveRoomBtn').addEventListener('click', () => leaveCurrentRoomToLobby(''));

document.getElementById('joinByIdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  enterRoomFromLobby(document.getElementById('lobbyRoomIdInput').value);
});

document.getElementById('lobbyCreateRoomBtn').addEventListener('click', () => {
  const randomId = Math.random().toString(36).substring(2, 9);
  enterRoomFromLobby(randomId);
});

let audioCtx = null;
let videoAudioSourceNode = null;
let videoAudioDestNode = null;
let localHostGainNode = null;
let mobileCanvasTimer = null;
let mobileRelayCanvas = null;

const cinemaVideo = document.getElementById('cinemaVideo');
const cinemaAudio = document.getElementById('cinemaAudio');
const stagePlaceholder = document.getElementById('stagePlaceholder');
const stopStreamBtn = document.getElementById('stopStreamBtn');
const queueToast = document.getElementById('queueToast');

const customPlayerBar = document.getElementById('customPlayerBar');
const playPauseBtn = document.getElementById('playPauseBtn');
const seekSlider = document.getElementById('seekSlider');
const currentTimeLabel = document.getElementById('currentTimeLabel');
const durationLabel = document.getElementById('durationLabel');

const roomPasswordBtn = document.getElementById('roomPasswordBtn');
const setPasswordModal = document.getElementById('setPasswordModal');
const setPasswordForm = document.getElementById('setPasswordForm');
const newRoomPasswordInput = document.getElementById('newRoomPasswordInput');
const setPasswordError = document.getElementById('setPasswordError');
const unlockRoomModal = document.getElementById('unlockRoomModal');
const unlockRoomForm = document.getElementById('unlockRoomForm');
const unlockPasswordInput = document.getElementById('unlockPasswordInput');
const unlockPasswordError = document.getElementById('unlockPasswordError');

function markPasswordLockedUI() {
  isPasswordLocked = true;
  roomPasswordBtn.textContent = '🔒 Password Locked';
  roomPasswordBtn.classList.remove('hover:bg-amber-600/90');
  roomPasswordBtn.classList.add('bg-emerald-950/80', 'border-emerald-600/50', 'text-emerald-300', 'cursor-default');
  setPasswordModal.classList.add('hidden');
  newRoomPasswordInput.value = '';
}

roomPasswordBtn.addEventListener('click', () => {
  if (!isRoomAuthorized) return;
  if (isPasswordLocked) {
    showToast('🔒 Room password is permanently locked and cannot be viewed or changed.');
    return;
  }
  setPasswordError.classList.add('hidden');
  newRoomPasswordInput.value = '';
  setPasswordModal.classList.remove('hidden');
  newRoomPasswordInput.focus();
});

document.getElementById('cancelSetPasswordBtn').addEventListener('click', () => {
  setPasswordModal.classList.add('hidden');
  newRoomPasswordInput.value = '';
});

setPasswordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pwd = newRoomPasswordInput.value.trim();
  if (pwd.length < 3) {
    setPasswordError.textContent = 'Password must be at least 3 characters.';
    setPasswordError.classList.remove('hidden');
    return;
  }
  socket.emit('set-room-password', { password: pwd });
  newRoomPasswordInput.value = '';
});

socket.on('room-password-locked', () => {
  markPasswordLockedUI();
  showToast('🔒 Room password locked! New visitors must enter it to join.');
});

socket.on('password-set-result', ({ ok, message }) => {
  if (!ok) {
    setPasswordError.textContent = message;
    setPasswordError.classList.remove('hidden');
  }
});

socket.on('password-required', () => {
  unlockPasswordError.classList.add('hidden');
  unlockRoomModal.classList.remove('hidden');
  unlockPasswordInput.focus();
});

socket.on('password-invalid', ({ message }) => {
  unlockPasswordError.textContent = message || 'Incorrect password.';
  unlockPasswordError.classList.remove('hidden');
  unlockPasswordInput.value = '';
  unlockPasswordInput.focus();
});

unlockRoomForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pwd = unlockPasswordInput.value;
  unlockPasswordInput.value = '';
  socket.emit('join-room', { roomId, password: pwd, displayName: profileName, clientId: TAB_CLIENT_ID });
});

document.getElementById('unlockNewRoomBtn').addEventListener('click', () => {
  const newId = Math.random().toString(36).substring(2, 9);
  window.location.href = `/room/${newId}`;
});

socket.connect();
socket.on('connect', () => {
  if (roomId) {
    socket.emit('join-room', { roomId, displayName: profileName, clientId: TAB_CLIENT_ID });
  }
});

let pendingCallUsers = [];
let mediaInitPromise = null;

async function ensureLocalCallMediaReady() {
  if (localCallStream && localCallStream.getTracks().length > 0) {
    return localCallStream;
  }
  if (mediaInitPromise) {
    return mediaInitPromise;
  }

  mediaInitPromise = (async () => {
    try {
      localCallStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      console.warn('Video+Audio failed, retrying Audio-only:', err);
      try {
        localCallStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { echoCancellation: true, noiseSuppression: true }
        });
      } catch (audioErr) {
        console.warn('Camera/Mic blocked or unavailable:', audioErr);
        localCallStream = new MediaStream();
      }
    }

    const localCamEl = document.getElementById('localCamVideo');
    if (localCamEl) {
      localCamEl.srcObject = localCallStream;
    }
    syncProfileBadge();
    syncLocalMediaButtonStates();
    mediaInitialized = true;
    mediaInitPromise = null;

    for (const [peerId, pc] of Object.entries(callPeers)) {
      if (!pc || pc.signalingState === 'closed') continue;
      let addedNewTrack = false;
      localCallStream.getTracks().forEach((track) => {
        const alreadySending = pc.getSenders().some((s) => s.track && s.track.kind === track.kind);
        if (!alreadySending) {
          pc.addTrack(track, localCallStream);
          addedNewTrack = true;
        }
      });
      if (addedNewTrack) {
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            socket.emit('offer', {
              target: peerId,
              sdp: pc.localDescription,
              mediaType: 'call'
            });
          })
          .catch(() => {});
      }
    }

    return localCallStream;
  })();

  return mediaInitPromise;
}

socket.on('join-success', async ({ isPasswordLocked: locked, peerNames }) => {
  if (document.body.classList.contains('in-lobby') || !roomId) {
    return;
  }
  isRoomAuthorized = true;
  unlockRoomModal.classList.add('hidden');
  if (locked) markPasswordLockedUI();

  if (peerNames && typeof peerNames === 'object') {
    Object.entries(peerNames).forEach(([id, name]) => {
      peerDisplayNames[id] = name;
      const badge = document.querySelector(`#tile-${id} .cam-badge`);
      if (badge) badge.textContent = name;
    });
  }

  await ensureLocalCallMediaReady();

  if (pendingCallUsers.length > 0) {
    knownPeers.clear();
    pendingCallUsers.forEach((userId) => {
      if (userId === socket.id) return;
      knownPeers.add(userId);
      createPeer(userId, 'call', true);
    });
    pendingCallUsers = [];
    updatePeerBadge();
    socket.emit('request-cinema');
  }
});

socket.on('all-users', async (users) => {
  const validUsers = users.filter((id) => id && id !== socket.id);

  Array.from(knownPeers).forEach((existingId) => {
    if (!validUsers.includes(existingId)) {
      knownPeers.delete(existingId);
      if (callPeers[existingId]) { callPeers[existingId].close(); delete callPeers[existingId]; }
      if (cinemaPeers[existingId]) { cinemaPeers[existingId].close(); delete cinemaPeers[existingId]; }
      const staleTile = document.getElementById(`tile-${existingId}`);
      if (staleTile) staleTile.remove();
      delete remoteCallVideos[existingId];
      delete peerDisplayNames[existingId];
    }
  });

  if (!mediaInitialized) {
    pendingCallUsers = validUsers;
    validUsers.forEach((userId) => knownPeers.add(userId));
    updatePeerBadge();
    await ensureLocalCallMediaReady();
    return;
  }

  validUsers.forEach((userId) => {
    knownPeers.add(userId);
    createPeer(userId, 'call', true);
  });
  updatePeerBadge();
  if (isRoomAuthorized && validUsers.length > 0) {
    socket.emit('request-cinema');
  }
});

const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatMessagesFeed = document.getElementById('chatMessagesFeed');

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isRoomAuthorized) return;
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  chatInput.value = '';
});

function appendTextWithClickableLinks(container, rawText) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = rawText.split(urlRegex);

  parts.forEach((part) => {
    if (!part) return;
    if (part.startsWith('http://') || part.startsWith('https://')) {
      try {
        const parsed = new URL(part);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          const a = document.createElement('a');
          a.href = parsed.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.className = 'chat-msg-link';
          a.textContent = part;
          container.appendChild(a);
          return;
        }
      } catch (_) {}
    }
    container.appendChild(document.createTextNode(part));
  });
}

socket.on('chat-updated', (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    chatMessagesFeed.classList.add('hidden');
    chatMessagesFeed.innerHTML = '';
    return;
  }

  chatMessagesFeed.classList.remove('hidden');
  chatMessagesFeed.innerHTML = '';

  messages.forEach((msg) => {
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg-bubble';

    const senderSpan = document.createElement('span');
    senderSpan.className = msg.senderId === socket.id
      ? 'font-semibold text-emerald-400 mr-1'
      : 'font-semibold text-indigo-300 mr-1';
    senderSpan.textContent = msg.senderId === socket.id ? 'You:' : `${msg.senderName}:`;

    bubble.appendChild(senderSpan);
    appendTextWithClickableLinks(bubble, msg.text);
    chatMessagesFeed.appendChild(bubble);
  });

  chatMessagesFeed.scrollTop = chatMessagesFeed.scrollHeight;
});

const toggleQueueBtn = document.getElementById('toggleQueueBtn');
const fsQueueBtn = document.getElementById('fsQueueBtn');
const queueDrawer = document.getElementById('queueDrawer');
const queueBackdrop = document.getElementById('queueBackdrop');
const closeQueueDrawerBtn = document.getElementById('closeQueueDrawerBtn');
const queueList = document.getElementById('queueList');
const queueCountBadge = document.getElementById('queueCountBadge');
const fsQueueBadge = document.getElementById('fsQueueBadge');
const loadFileLabel = document.getElementById('loadFileLabel');

function openQueueDrawer() {
  queueDrawer.classList.add('open');
  queueBackdrop.classList.remove('hidden');
}

function closeQueueDrawer() {
  queueDrawer.classList.remove('open');
  queueBackdrop.classList.add('hidden');
}

toggleQueueBtn.addEventListener('click', openQueueDrawer);
fsQueueBtn.addEventListener('click', openQueueDrawer);
closeQueueDrawerBtn.addEventListener('click', closeQueueDrawer);
queueBackdrop.addEventListener('click', closeQueueDrawer);

const fullscreenBtn = document.getElementById('fullscreenBtn');
const exitFullscreenBtn = document.getElementById('exitFullscreenBtn');
const videoGestureZone = document.getElementById('videoGestureZone');
const videoFrameBox = document.querySelector('.video-frame-box');
let hideBarTimer = null;

function resetPlayerBarAutoHide() {
  customPlayerBar.classList.remove('bar-hidden');
  if (hideBarTimer) clearTimeout(hideBarTimer);

  if (document.body.classList.contains('theater-fullscreen') && !isDraggingSlider) {
    hideBarTimer = setTimeout(() => {
      customPlayerBar.classList.add('bar-hidden');
    }, 3000);
  }
}

async function toggleTheaterFullscreen(forceState) {
  const shouldEnter = typeof forceState === 'boolean'
    ? forceState
    : !document.body.classList.contains('theater-fullscreen');

  if (shouldEnter) {
    document.body.classList.add('theater-fullscreen');
    fullscreenBtn.textContent = '🗗';

    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape').catch(() => {});
    }
    resetPlayerBarAutoHide();
  } else {
    document.body.classList.remove('theater-fullscreen');
    customPlayerBar.classList.remove('bar-hidden');
    if (hideBarTimer) clearTimeout(hideBarTimer);
    fullscreenBtn.textContent = '⛶';

    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch (_) {}
    }
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen().catch(() => {});
    }
  }
}

fullscreenBtn.addEventListener('click', () => toggleTheaterFullscreen());
exitFullscreenBtn.addEventListener('click', () => toggleTheaterFullscreen(false));

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('theater-fullscreen')) {
    document.body.classList.remove('theater-fullscreen');
    customPlayerBar.classList.remove('bar-hidden');
    if (hideBarTimer) clearTimeout(hideBarTimer);
    fullscreenBtn.textContent = '⛶';
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch (_) {}
    }
  }
});

videoFrameBox.addEventListener('mousemove', resetPlayerBarAutoHide);
videoFrameBox.addEventListener('touchstart', resetPlayerBarAutoHide, { passive: true });
customPlayerBar.addEventListener('mousemove', resetPlayerBarAutoHide);
customPlayerBar.addEventListener('touchstart', resetPlayerBarAutoHide, { passive: true });

function showSeekFeedback(side, text) {
  const existing = videoFrameBox.querySelector('.seek-toast-pill');
  if (existing) existing.remove();

  const pill = document.createElement('div');
  pill.className = `seek-toast-pill ${side}`;
  pill.textContent = text;
  videoFrameBox.appendChild(pill);
  setTimeout(() => pill.remove(), 680);
}

function seekRelativeSeconds(deltaSec) {
  const maxDur = parseFloat(seekSlider.max) || (isHostingCinema ? cinemaVideo.duration : 0) || 0;
  const currentPos = isHostingCinema ? cinemaVideo.currentTime : parseFloat(seekSlider.value);
  const nextTime = Math.max(0, Math.min(maxDur || currentPos + deltaSec, currentPos + deltaSec));

  seekSlider.value = nextTime;
  currentTimeLabel.textContent = formatTime(nextTime);

  if (isHostingCinema) {
    cinemaVideo.currentTime = nextTime;
  } else {
    socket.emit('cinema-sync', { action: 'seek', currentTime: nextTime });
  }
}

let singleTapTimer = null;
let lastTapTime = 0;

videoGestureZone.addEventListener('click', (e) => {
  resetPlayerBarAutoHide();
  const now = Date.now();
  const rect = videoGestureZone.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const isLeftSide = clickX < rect.width * 0.45;

  if (now - lastTapTime < 280) {
    if (singleTapTimer) {
      clearTimeout(singleTapTimer);
      singleTapTimer = null;
    }
    lastTapTime = 0;

    if (isLeftSide) {
      seekRelativeSeconds(-10);
      showSeekFeedback('left', '⏪ -10s');
    } else {
      seekRelativeSeconds(10);
      showSeekFeedback('right', '+10s ⏩');
    }
    return;
  }

  lastTapTime = now;
  singleTapTimer = setTimeout(() => {
    singleTapTimer = null;
    playPauseBtn.click();
  }, 250);
});

function showToast(msg) {
  queueToast.textContent = msg;
  queueToast.classList.remove('hidden');
  setTimeout(() => queueToast.classList.add('hidden'), 3200);
}

function ensureHostCinemaAudioGraph() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  if (!videoAudioSourceNode) {
    videoAudioSourceNode = audioCtx.createMediaElementSource(cinemaVideo);
    videoAudioDestNode = audioCtx.createMediaStreamDestination();
    localHostGainNode = audioCtx.createGain();

    const currentSliderVol = parseFloat(document.getElementById('cinemaVolume').value);
    localHostGainNode.gain.value = isFinite(currentSliderVol) ? currentSliderVol : 1;

    videoAudioSourceNode.connect(localHostGainNode);
    localHostGainNode.connect(audioCtx.destination);

    videoAudioSourceNode.connect(videoAudioDestNode);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return videoAudioDestNode.stream.getAudioTracks()[0];
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '00:00';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = Math.floor(sec % 60);
  const mm = mins < 10 ? `0${mins}` : `${mins}`;
  const ss = secs < 10 ? `0${secs}` : `${secs}`;
  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

function updatePeerBadge() {
  const count = knownPeers.size + 1;
  document.getElementById('peerCountBadge').textContent = `● ${count} in Room`;
}

function updateCameraExpandButtons() {
  const isStreamBusy = Boolean(isHostingCinema || roomActiveHostId || currentCinemaMode);
  document.body.classList.toggle('cinema-active', isStreamBusy);

  document.querySelectorAll('.cam-tile').forEach((tile) => {
    tile.classList.remove('is-focused-on-stage');
  });
  document.querySelectorAll('.cam-expand-btn').forEach((btn) => {
    btn.textContent = '⛶';
    btn.title = 'Expand camera to center stage';
  });

  if (focusedCameraPeerId && !isStreamBusy) {
    const activeTile = document.getElementById(`tile-${focusedCameraPeerId}`);
    const activeBtn = activeTile?.querySelector('.cam-expand-btn');
    if (activeTile) activeTile.classList.add('is-focused-on-stage');
    if (activeBtn) {
      activeBtn.textContent = '🗗';
      activeBtn.title = 'Return camera to sidebar';
    }
  }
}

function clearFocusedCameraOnStage() {
  if (!focusedCameraPeerId) return;
  focusedCameraPeerId = null;

  if (!isHostingCinema && !roomActiveHostId && !currentCinemaMode) {
    cinemaVideo.pause();
    cinemaVideo.srcObject = null;
    cinemaVideo.classList.remove('is-local-mirror');
    stagePlaceholder.classList.remove('hidden');
  }
  updateCameraExpandButtons();
}

function toggleCameraFocusOnStage(peerId) {
  if (isHostingCinema || roomActiveHostId || currentCinemaMode) {
    showToast('Stop the active movie or screen share first to expand a camera.');
    return;
  }

  if (focusedCameraPeerId === peerId) {
    clearFocusedCameraOnStage();
    return;
  }

  const targetStream = peerId === 'local'
    ? localCallStream
    : remoteCallVideos[peerId]?.srcObject;

  if (!targetStream) return;

  focusedCameraPeerId = peerId;
  cinemaVideo.removeAttribute('src');
  cinemaVideo.srcObject = targetStream;
  cinemaVideo.classList.toggle('is-local-mirror', peerId === 'local');
  cinemaVideo.muted = true;
  stagePlaceholder.classList.add('hidden');
  cinemaVideo.play().catch(() => {});
  updateCameraExpandButtons();
}

document.getElementById('localCamExpandBtn').addEventListener('click', () => {
  toggleCameraFocusOnStage('local');
});

function createPeer(targetId, mediaType, isInitiator) {
  const peerStore = mediaType === 'call' ? callPeers : cinemaPeers;
  if (peerStore[targetId]) {
    peerStore[targetId].close();
  }
  iceCandidateQueues[mediaType][targetId] = [];

  const pc = new RTCPeerConnection(rtcConfig);
  peerStore[targetId] = pc;

  const streamToAttach = mediaType === 'call' ? localCallStream : localCinemaStream;
  if (streamToAttach && streamToAttach.getTracks().length > 0) {
    streamToAttach.getTracks().forEach((track) => pc.addTrack(track, streamToAttach));
  } else if (mediaType === 'call') {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', {
        target: targetId,
        candidate: e.candidate,
        mediaType
      });
    }
  };

  if (mediaType === 'call') {
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected') {
        setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            pc.restartIce();
          }
        }, 2500);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        const staleTile = document.getElementById(`tile-${targetId}`);
        if (staleTile) staleTile.remove();
        delete remoteCallVideos[targetId];
        knownPeers.delete(targetId);
        updatePeerBadge();
      }
    };
  }

  pc.ontrack = (e) => {
    const remoteStream = e.streams[0] || new MediaStream([e.track]);
    if (mediaType === 'call' && targetId !== socket.id) {
      renderRemoteCallVideo(targetId, remoteStream);
    } else if (mediaType === 'cinema' && !isHostingCinema) {
      focusedCameraPeerId = null;
      stagePlaceholder.classList.add('hidden');
      stopStreamBtn.classList.remove('hidden');
      customPlayerBar.classList.remove('hidden');

      if (cinemaVideo.srcObject !== remoteStream) {
        cinemaVideo.removeAttribute('src');
        cinemaVideo.srcObject = remoteStream;
      }
      cinemaVideo.muted = true;
      cinemaVideo.play().catch(() => {});

      if (cinemaAudio.srcObject !== remoteStream) {
        cinemaAudio.removeAttribute('src');
        cinemaAudio.srcObject = remoteStream;
      }
      cinemaAudio.muted = false;
      cinemaAudio.volume = parseFloat(document.getElementById('cinemaVolume').value);
      cinemaAudio.play().catch(() => {});
    }
  };

  if (isInitiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('offer', {
          target: targetId,
          sdp: pc.localDescription,
          mediaType
        });
      });
  }

  return pc;
}

async function flushIceQueue(pc, mediaType, peerId) {
  const queue = iceCandidateQueues[mediaType][peerId] || [];
  while (queue.length > 0) {
    const candidate = queue.shift();
    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}

socket.on('user-joined', (payload) => {
  const userId = typeof payload === 'string' ? payload : payload?.userId;
  const displayName = typeof payload === 'object' ? payload?.displayName : '';
  if (!userId || userId === socket.id) return;

  knownPeers.add(userId);
  if (displayName) {
    peerDisplayNames[userId] = displayName;
    const badge = document.querySelector(`#tile-${userId} .cam-badge`);
    if (badge) badge.textContent = displayName;
  }
  updatePeerBadge();
});

socket.on('request-cinema', ({ requesterId }) => {
  if (!requesterId || requesterId === socket.id) return;
  knownPeers.add(requesterId);
  updatePeerBadge();
  if (isHostingCinema && localCinemaStream) {
    createPeer(requesterId, 'cinema', true);
    socket.emit('cinema-time', {
      currentTime: cinemaVideo.currentTime || 0,
      duration: cinemaVideo.duration || 0,
      paused: cinemaVideo.paused,
      ended: cinemaVideo.ended
    });
  }
});

socket.on('queue-updated', ({ activeHostId, queue }) => {
  roomActiveHostId = activeHostId;
  if (activeHostId && focusedCameraPeerId) {
    clearFocusedCameraOnStage();
  }
  updateCameraExpandButtons();
  queueCountBadge.textContent = queue.length;
  fsQueueBadge.textContent = queue.length;

  loadFileLabel.textContent = activeHostId ? '➕ Add Video to Queue' : '📂 Load Local Video';

  if (queue.length === 0) {
    queueList.innerHTML = '<p class="text-xs text-slate-500 italic">Queue is empty. Load a video while another is playing to add it here.</p>';
    return;
  }

  queueList.innerHTML = '';
  queue.forEach((item, index) => {
    const isMine = item.ownerId === socket.id;
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2';

    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';

    const titleP = document.createElement('p');
    titleP.className = 'text-xs font-medium text-slate-200 truncate';
    titleP.textContent = `${index + 1}. ${item.title}`;

    const ownerP = document.createElement('p');
    ownerP.className = 'text-[10px] text-slate-400';
    ownerP.textContent = `Queued by ${isMine ? 'You' : item.ownerName}`;

    info.appendChild(titleP);
    info.appendChild(ownerP);

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1.5 shrink-0';

    const playNowBtn = document.createElement('button');
    playNowBtn.className = 'bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold px-2.5 py-1 rounded transition';
    playNowBtn.textContent = '▶ Play';
    playNowBtn.onclick = () => {
      closeQueueDrawer();
      socket.emit('queue-play-now', { queueId: item.queueId });
    };

    const removeBtn = document.createElement('button');
    removeBtn.className = 'bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-white text-[11px] px-2 py-1 rounded transition';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove from queue';
    removeBtn.onclick = () => {
      if (isMine) localQueuedFiles.delete(item.queueId);
      socket.emit('queue-remove', { queueId: item.queueId });
    };

    actions.appendChild(playNowBtn);
    actions.appendChild(removeBtn);
    row.appendChild(info);
    row.appendChild(actions);
    queueList.appendChild(row);
  });
});

socket.on('start-queued-item', ({ queueId }) => {
  const file = localQueuedFiles.get(queueId);
  if (!file) return;
  localQueuedFiles.delete(queueId);
  startStreamingLocalFile(file);
});

socket.on('offer', async ({ sdp, caller, mediaType }) => {
  if (!caller || caller === socket.id) return;
  if (mediaType === 'call' && !mediaInitialized) {
    await ensureLocalCallMediaReady();
  }
  knownPeers.add(caller);
  updatePeerBadge();
  const peerStore = mediaType === 'call' ? callPeers : cinemaPeers;
  const existingPc = peerStore[caller];
  const pc = (existingPc && existingPc.signalingState !== 'closed')
    ? existingPc
    : createPeer(caller, mediaType, false);

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushIceQueue(pc, mediaType, caller);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', {
    target: caller,
    sdp: pc.localDescription,
    mediaType
  });
});

socket.on('answer', async ({ sdp, callee, mediaType }) => {
  const peerStore = mediaType === 'call' ? callPeers : cinemaPeers;
  const pc = peerStore[callee];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushIceQueue(pc, mediaType, callee);
  }
});

socket.on('ice-candidate', async ({ candidate, from, mediaType }) => {
  const peerStore = mediaType === 'call' ? callPeers : cinemaPeers;
  const pc = peerStore[from];
  if (pc && pc.remoteDescription) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  } else {
    if (!iceCandidateQueues[mediaType][from]) iceCandidateQueues[mediaType][from] = [];
    iceCandidateQueues[mediaType][from].push(candidate);
  }
});

socket.on('cinema-status', ({ active }) => {
  if (!active) {
    if (document.body.classList.contains('theater-fullscreen')) {
      toggleTheaterFullscreen(false);
    }
    cleanupLocalCinemaUI();
  }
});

socket.on('cinema-time', ({ currentTime, duration, paused, ended }) => {
  if (isHostingCinema || isDraggingSlider) return;
  isRemotePaused = paused;

  if (ended) {
    playPauseBtn.textContent = '▶ Replay';
  } else {
    playPauseBtn.textContent = paused ? '▶ Play' : '⏸ Pause';
  }

  if (isFinite(duration) && duration > 0) {
    seekSlider.max = duration;
    seekSlider.value = ended ? duration : currentTime;
    currentTimeLabel.textContent = formatTime(ended ? duration : currentTime);
    durationLabel.textContent = formatTime(duration);
  }
});

socket.on('cinema-sync', async ({ action, currentTime }) => {
  isRemoteSyncing = true;
  if (isHostingCinema && currentCinemaMode === 'file') {
    if (action === 'seek') {
      cinemaVideo.currentTime = currentTime;
    }
    if (action === 'play') {
      await cinemaVideo.play().catch(() => {});
    } else if (action === 'pause') {
      cinemaVideo.pause();
    }
    playPauseBtn.textContent = cinemaVideo.ended
      ? '▶ Replay'
      : (cinemaVideo.paused ? '▶ Play' : '⏸ Pause');
  } else if (!isHostingCinema) {
    if (action === 'play' || action === 'seek') {
      isRemotePaused = false;
      playPauseBtn.textContent = '⏸ Pause';
      if (cinemaVideo.srcObject) cinemaVideo.play().catch(() => {});
      if (cinemaAudio.srcObject) cinemaAudio.play().catch(() => {});
    } else if (action === 'ended') {
      isRemotePaused = true;
      playPauseBtn.textContent = '▶ Replay';
      seekSlider.value = seekSlider.max;
      currentTimeLabel.textContent = durationLabel.textContent;
    } else if (action === 'pause') {
      isRemotePaused = true;
      playPauseBtn.textContent = '▶ Play';
      cinemaVideo.pause();
      cinemaAudio.pause();
    }
  }
  setTimeout(() => { isRemoteSyncing = false; }, 250);
});

socket.on('user-left', (userId) => {
  knownPeers.delete(userId);
  updatePeerBadge();
  if (callPeers[userId]) { callPeers[userId].close(); delete callPeers[userId]; }
  if (cinemaPeers[userId]) { cinemaPeers[userId].close(); delete cinemaPeers[userId]; }
  const tile = document.getElementById(`tile-${userId}`);
  if (tile) tile.remove();
  delete remoteCallVideos[userId];
  if (focusedCameraPeerId === userId) {
    clearFocusedCameraOnStage();
  }
  delete peerDisplayNames[userId];
});

function renderRemoteCallVideo(userId, stream) {
  let videoEl = remoteCallVideos[userId];
  if (!videoEl) {
    const tile = document.createElement('div');
    tile.id = `tile-${userId}`;
    tile.className = 'cam-tile';

    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;

    const label = document.createElement('span');
    label.className = 'cam-badge';
    label.textContent = peerDisplayNames[userId] || `Friend (${userId.slice(0, 4)})`;

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'cam-expand-btn';
    expandBtn.textContent = '⛶';
    expandBtn.title = 'Expand camera to center stage';
    expandBtn.addEventListener('click', () => toggleCameraFocusOnStage(userId));

    tile.appendChild(videoEl);
    tile.appendChild(label);
    tile.appendChild(expandBtn);
    document.getElementById('webcamGrid').appendChild(tile);
    remoteCallVideos[userId] = videoEl;
  }
  videoEl.srcObject = stream;
  const existingBadge = document.querySelector(`#tile-${userId} .cam-badge`);
  if (existingBadge && peerDisplayNames[userId]) {
    existingBadge.textContent = peerDisplayNames[userId];
  }
  videoEl.volume = parseFloat(document.getElementById('callVolume').value);
  videoEl.play().catch(() => {});

  if (focusedCameraPeerId === userId && cinemaVideo.srcObject !== stream) {
    cinemaVideo.srcObject = stream;
    cinemaVideo.play().catch(() => {});
  }
  updateCameraExpandButtons();
}

playPauseBtn.addEventListener('click', () => {
  if (isHostingCinema) {
    if (cinemaVideo.ended) {
      cinemaVideo.currentTime = 0;
      cinemaVideo.play().catch(() => {});
    } else if (cinemaVideo.paused) {
      cinemaVideo.play().catch(() => {});
    } else {
      cinemaVideo.pause();
    }
  } else {
    const isAtEnd =
      playPauseBtn.textContent.includes('Replay') ||
      (parseFloat(seekSlider.max) > 0 &&
        parseFloat(seekSlider.value) >= parseFloat(seekSlider.max) - 0.5);

    if (isAtEnd) {
      isRemotePaused = false;
      playPauseBtn.textContent = '⏸ Pause';
      seekSlider.value = 0;
      currentTimeLabel.textContent = '00:00';
      socket.emit('cinema-sync', { action: 'seek', currentTime: 0 });
      socket.emit('cinema-sync', { action: 'play', currentTime: 0 });
    } else if (isRemotePaused) {
      isRemotePaused = false;
      playPauseBtn.textContent = '⏸ Pause';
      cinemaVideo.play().catch(() => {});
      cinemaAudio.play().catch(() => {});
      socket.emit('cinema-sync', { action: 'play', currentTime: parseFloat(seekSlider.value) });
    } else {
      isRemotePaused = true;
      playPauseBtn.textContent = '▶ Play';
      cinemaVideo.pause();
      cinemaAudio.pause();
      socket.emit('cinema-sync', { action: 'pause', currentTime: parseFloat(seekSlider.value) });
    }
  }
});

seekSlider.addEventListener('input', () => {
  isDraggingSlider = true;
  currentTimeLabel.textContent = formatTime(parseFloat(seekSlider.value));
});

seekSlider.addEventListener('change', () => {
  const targetTime = parseFloat(seekSlider.value);
  isDraggingSlider = false;
  if (isHostingCinema) {
    cinemaVideo.currentTime = targetTime;
  } else {
    socket.emit('cinema-sync', { action: 'seek', currentTime: targetTime });
  }
});

function handleLocalFileSelect(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !isRoomAuthorized) return;

  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  if (roomActiveHostId || isHostingCinema) {
    const queueId = Math.random().toString(36).substring(2, 10);
    localQueuedFiles.set(queueId, file);
    socket.emit('queue-add', {
      queueId,
      title: file.name,
      type: 'file'
    });
    showToast(`📋 Added "${file.name}" to Queue`);
    return;
  }

  startStreamingLocalFile(file);
}

async function startStreamingLocalFile(file) {
  cleanupLocalCinemaUI();
  clearFocusedCameraOnStage();

  isHostingCinema = true;
  roomActiveHostId = socket.id;
  currentCinemaMode = 'file';

  currentObjectUrl = URL.createObjectURL(file);
  cinemaVideo.srcObject = null;
  cinemaAudio.srcObject = null;
  cinemaVideo.src = currentObjectUrl;
  cinemaVideo.muted = false;
  cinemaVideo.volume = parseFloat(document.getElementById('cinemaVolume').value);
  stagePlaceholder.classList.add('hidden');
  stopStreamBtn.classList.remove('hidden');
  customPlayerBar.classList.remove('hidden');

  cinemaVideo.oncanplay = async () => {
    cinemaVideo.oncanplay = null;
    if (isFinite(cinemaVideo.duration)) {
      seekSlider.max = cinemaVideo.duration;
      durationLabel.textContent = formatTime(cinemaVideo.duration);
    }
    cinemaVideo.muted = false;
    cinemaVideo.volume = 1;
    const cleanAudioTrack = ensureHostCinemaAudioGraph();

    await cinemaVideo.play().catch(() => {});
    playPauseBtn.textContent = '⏸ Pause';

    setTimeout(() => {
      const isMobileDevice = /Android|iPhone|iPad/i.test(navigator.userAgent);
      let videoCapture;

      if (isMobileDevice) {
        const relayCanvas = document.createElement('canvas');
        const vw = cinemaVideo.videoWidth || 1280;
        const vh = cinemaVideo.videoHeight || 720;
        const scale = Math.min(1, 720 / vw);
        relayCanvas.width = Math.round(vw * scale);
        relayCanvas.height = Math.round(vh * scale);

        relayCanvas.className = 'mobile-relay-canvas';
        document.body.appendChild(relayCanvas);
        mobileRelayCanvas = relayCanvas;

        const ctx = relayCanvas.getContext('2d', { alpha: false });
        ctx.drawImage(cinemaVideo, 0, 0, relayCanvas.width, relayCanvas.height);

        videoCapture = relayCanvas.captureStream(20);

        mobileCanvasTimer = setInterval(() => {
          if (!isHostingCinema || currentCinemaMode !== 'file') {
            clearInterval(mobileCanvasTimer);
            mobileCanvasTimer = null;
            return;
          }
          if (cinemaVideo.readyState >= 2 && !cinemaVideo.paused) {
            ctx.drawImage(cinemaVideo, 0, 0, relayCanvas.width, relayCanvas.height);
          }
        }, 50);
      } else {
        const rawCapture = cinemaVideo.captureStream
          ? cinemaVideo.captureStream(30)
          : cinemaVideo.mozCaptureStream(30);
        videoCapture = new MediaStream(rawCapture.getVideoTracks());
      }

      if (cleanAudioTrack) {
        videoCapture.addTrack(cleanAudioTrack);
      }

      localCinemaStream = videoCapture;
      broadcastCinemaStream('file');
    }, 300);
  };
}

document.getElementById('localFileInput').addEventListener('change', handleLocalFileSelect);
document.getElementById('localFileInputBar').addEventListener('change', handleLocalFileSelect);
document.getElementById('localFileInputDrawer').addEventListener('change', handleLocalFileSelect);

let lastTimeBroadcastMs = 0;
cinemaVideo.addEventListener('timeupdate', () => {
  if (!isHostingCinema) return;
  const now = cinemaVideo.currentTime;

  if (!isDraggingSlider && isFinite(cinemaVideo.duration)) {
    seekSlider.max = cinemaVideo.duration;
    seekSlider.value = now;
    currentTimeLabel.textContent = formatTime(now);
    durationLabel.textContent = formatTime(cinemaVideo.duration);
  }

  if (Date.now() - lastTimeBroadcastMs >= 1000) {
    lastTimeBroadcastMs = Date.now();
    socket.emit('cinema-time', {
      currentTime: now,
      duration: cinemaVideo.duration || 0,
      paused: cinemaVideo.paused,
      ended: cinemaVideo.ended
    });
  }
});

cinemaVideo.addEventListener('ended', () => {
  didVideoEnd = true;
  playPauseBtn.textContent = '▶ Replay';
  if (isFinite(cinemaVideo.duration)) {
    seekSlider.max = cinemaVideo.duration;
    seekSlider.value = cinemaVideo.duration;
    currentTimeLabel.textContent = formatTime(cinemaVideo.duration);
    durationLabel.textContent = formatTime(cinemaVideo.duration);
  }
  socket.emit('cinema-time', {
    currentTime: cinemaVideo.duration || cinemaVideo.currentTime,
    duration: cinemaVideo.duration || 0,
    paused: true,
    ended: true
  });
  socket.emit('cinema-sync', { action: 'ended', currentTime: cinemaVideo.duration || cinemaVideo.currentTime });
});

cinemaVideo.addEventListener('play', async () => {
  playPauseBtn.textContent = '⏸ Pause';
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  if (isHostingCinema && currentCinemaMode === 'file') {
    const currentVidTrack = localCinemaStream?.getVideoTracks()[0];
    if (didVideoEnd || !currentVidTrack || currentVidTrack.readyState === 'ended') {
      didVideoEnd = false;
      await refreshCinemaCaptureTracks();
    }
  }

  if (!isRemoteSyncing) {
    socket.emit('cinema-sync', { action: 'play', currentTime: cinemaVideo.currentTime });
  }
});

cinemaVideo.addEventListener('pause', () => {
  if (cinemaVideo.ended) return;
  playPauseBtn.textContent = '▶ Play';
  if (!isRemoteSyncing) {
    socket.emit('cinema-sync', { action: 'pause', currentTime: cinemaVideo.currentTime });
  }
});

cinemaVideo.addEventListener('seeked', () => {
  if (!isRemoteSyncing) {
    socket.emit('cinema-sync', { action: 'seek', currentTime: cinemaVideo.currentTime });
  }
});

function unlockAllAudioOnGesture() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const cinemaVol = parseFloat(document.getElementById('cinemaVolume').value);
  if (isHostingCinema) {
    cinemaVideo.muted = false;
    cinemaVideo.volume = 1;
    if (localHostGainNode) localHostGainNode.gain.value = cinemaVol;
  } else if (cinemaAudio.srcObject) {
    cinemaAudio.muted = false;
    cinemaAudio.volume = cinemaVol;
    cinemaAudio.play().catch(() => {});
  }
  const callVol = parseFloat(document.getElementById('callVolume').value);
  Object.values(remoteCallVideos).forEach((v) => {
    v.muted = false;
    v.volume = callVol;
    v.play().catch(() => {});
  });
}
document.addEventListener('pointerdown', unlockAllAudioOnGesture, { once: true });

async function startScreenShare() {
  if (!isRoomAuthorized) return;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    alert('Screen sharing is only supported on Desktop Chrome/Edge browsers. On mobile, use "Load Local Video".');
    return;
  }
  if (roomActiveHostId || isHostingCinema) {
    alert('A video is already active in this room. Stop the current movie first before starting Screen Share.');
    return;
  }
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude'
    });

    cleanupLocalCinemaUI();
    clearFocusedCameraOnStage();
    isHostingCinema = true;
    roomActiveHostId = socket.id;
    currentCinemaMode = 'screen';
    localCinemaStream = screenStream;

    cinemaVideo.src = '';
    cinemaVideo.srcObject = screenStream;
    cinemaVideo.muted = true;
    stagePlaceholder.classList.add('hidden');
    stopStreamBtn.classList.remove('hidden');
    await cinemaVideo.play();

    broadcastCinemaStream('screen');
    if (window.FlickSyncFloatingPiP) {
      window.FlickSyncFloatingPiP.showButton();
      await window.FlickSyncFloatingPiP.open();
    }

    screenStream.getVideoTracks()[0].onended = () => {
      socket.emit('cinema-status', { active: false });
    };
  } catch (err) {
    console.warn('Screen share cancelled:', err);
  }
}

document.getElementById('shareScreenBtn').addEventListener('click', startScreenShare);
document.getElementById('shareScreenBtnBar').addEventListener('click', startScreenShare);

function broadcastCinemaStream(mode) {
  socket.emit('cinema-status', { active: true, mode });
  knownPeers.forEach((peerId) => {
    createPeer(peerId, 'cinema', true);
  });
}

stopStreamBtn.addEventListener('click', () => {
  socket.emit('cinema-status', { active: false });
});

const cinemaVolumeSlider = document.getElementById('cinemaVolume');
const fsCinemaVolumeSlider = document.getElementById('fsCinemaVolume');
const fsMovieVolPct = document.getElementById('fsMovieVolPct');

async function refreshCinemaCaptureTracks() {
  if (!isHostingCinema || currentCinemaMode !== 'file') return;
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) return;

  const freshCapture = cinemaVideo.captureStream
    ? cinemaVideo.captureStream(30)
    : cinemaVideo.mozCaptureStream(30);

  const freshVideoTrack = freshCapture.getVideoTracks()[0];
  if (!freshVideoTrack) return;

  const tracksToUse = [freshVideoTrack];
  const freshAudioTrack = ensureHostCinemaAudioGraph();
  if (freshAudioTrack) tracksToUse.push(freshAudioTrack);

  localCinemaStream = new MediaStream(tracksToUse);

  const peerIds = Array.from(knownPeers);
  for (const peerId of peerIds) {
    const pc = cinemaPeers[peerId];
    if (pc && pc.connectionState === 'connected') {
      const senders = pc.getSenders();
      const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
      const audioSender = senders.find((s) => s.track && s.track.kind === 'audio');
      if (videoSender && freshVideoTrack) {
        await videoSender.replaceTrack(freshVideoTrack).catch(() => {});
      }
      if (audioSender && freshAudioTrack) {
        await audioSender.replaceTrack(freshAudioTrack).catch(() => {});
      }
    } else {
      createPeer(peerId, 'cinema', true);
    }
  }
}

function cleanupLocalCinemaUI() {
  isHostingCinema = false;
  didVideoEnd = false;
  currentCinemaMode = null;

  if (window.FlickSyncFloatingPiP) window.FlickSyncFloatingPiP.close();

  if (mobileCanvasTimer) {
    clearInterval(mobileCanvasTimer);
    mobileCanvasTimer = null;
  }
  if (mobileRelayCanvas) {
    mobileRelayCanvas.remove();
    mobileRelayCanvas = null;
  }

  if (localCinemaStream) {
    localCinemaStream.getTracks().forEach((t) => t.stop());
    localCinemaStream = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  Object.values(cinemaPeers).forEach((pc) => pc.close());
  for (const k in cinemaPeers) delete cinemaPeers[k];

  cinemaVideo.pause();
  cinemaVideo.srcObject = null;
  cinemaVideo.removeAttribute('src');
  cinemaVideo.classList.remove('is-local-mirror');
  cinemaAudio.pause();
  cinemaAudio.srcObject = null;
  cinemaAudio.removeAttribute('src');
  customPlayerBar.classList.add('hidden');

  stagePlaceholder.classList.remove('hidden');
  stopStreamBtn.classList.add('hidden');
  updateCameraExpandButtons();
}

function applyCinemaVolume(vol) {
  const safeVol = Math.max(0, Math.min(1, vol));
  cinemaVolumeSlider.value = safeVol;
  fsCinemaVolumeSlider.value = safeVol;
  fsMovieVolPct.textContent = `${Math.round(safeVol * 100)}%`;

  cinemaAudio.muted = false;
  cinemaAudio.volume = safeVol;

  if (isHostingCinema) {
    cinemaVideo.muted = false;
    cinemaVideo.volume = 1;
    if (localHostGainNode) {
      localHostGainNode.gain.value = safeVol;
    }
  }
}

cinemaVolumeSlider.addEventListener('input', (e) => applyCinemaVolume(parseFloat(e.target.value)));
fsCinemaVolumeSlider.addEventListener('input', (e) => applyCinemaVolume(parseFloat(e.target.value)));

const callVolumeSlider = document.getElementById('callVolume');
const fsCallVolumeSlider = document.getElementById('fsCallVolume');
const fsCallVolPct = document.getElementById('fsCallVolPct');

function applyCallVolume(vol) {
  const safeVol = Math.max(0, Math.min(1, vol));
  callVolumeSlider.value = safeVol;
  fsCallVolumeSlider.value = safeVol;
  fsCallVolPct.textContent = `${Math.round(safeVol * 100)}%`;

  Object.values(remoteCallVideos).forEach((videoEl) => {
    videoEl.muted = false;
    videoEl.volume = safeVol;
  });
}

callVolumeSlider.addEventListener('input', (e) => applyCallVolume(parseFloat(e.target.value)));
fsCallVolumeSlider.addEventListener('input', (e) => applyCallVolume(parseFloat(e.target.value)));

const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCamBtn = document.getElementById('toggleCamBtn');

function syncLocalMediaButtonStates() {
  const audioTrack = localCallStream?.getAudioTracks()[0];
  const micEnabled = Boolean(audioTrack && audioTrack.enabled);
  toggleMicBtn.textContent = micEnabled ? '🎤 Mic On' : '🔇 Mic Muted';
  toggleMicBtn.classList.toggle('bg-rose-600', !micEnabled);

  const videoTrack = localCallStream?.getVideoTracks()[0];
  const camEnabled = Boolean(videoTrack && videoTrack.enabled);
  toggleCamBtn.textContent = camEnabled ? '📷 Cam On' : '🚫 Cam Off';
  toggleCamBtn.classList.toggle('bg-rose-600', !camEnabled);
}

toggleMicBtn.addEventListener('click', async () => {
  if (!isRoomAuthorized) return;
  await ensureLocalCallMediaReady();
  let audioTrack = localCallStream?.getAudioTracks()[0];

  if (!audioTrack) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        if (!localCallStream) localCallStream = new MediaStream();
        localCallStream.addTrack(audioTrack);
        for (const [peerId, pc] of Object.entries(callPeers)) {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
          if (sender) {
            await sender.replaceTrack(audioTrack).catch(() => {});
          } else {
            pc.addTrack(audioTrack, localCallStream);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('offer', { target: peerId, sdp: pc.localDescription, mediaType: 'call' });
          }
        }
      }
    } catch (err) {
      showToast('Microphone permission denied or unavailable.');
      return;
    }
  } else {
    audioTrack.enabled = !audioTrack.enabled;
  }
  syncLocalMediaButtonStates();
});

toggleCamBtn.addEventListener('click', async () => {
  if (!isRoomAuthorized) return;
  await ensureLocalCallMediaReady();
  let videoTrack = localCallStream?.getVideoTracks()[0];

  if (!videoTrack) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 } }
      });
      videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        if (!localCallStream) localCallStream = new MediaStream();
        localCallStream.addTrack(videoTrack);
        document.getElementById('localCamVideo').srcObject = localCallStream;
        for (const [peerId, pc] of Object.entries(callPeers)) {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) {
            await sender.replaceTrack(videoTrack).catch(() => {});
          } else {
            pc.addTrack(videoTrack, localCallStream);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('offer', { target: peerId, sdp: pc.localDescription, mediaType: 'call' });
          }
        }
      }
    } catch (err) {
      showToast('Camera permission denied or unavailable.');
      return;
    }
  } else {
    videoTrack.enabled = !videoTrack.enabled;
  }
  syncLocalMediaButtonStates();
});

document.getElementById('newRoomBtn').addEventListener('click', () => {
  const newId = Math.random().toString(36).substring(2, 9);
  window.location.href = `/room/${newId}`;
});

document.getElementById('copyLinkBtn').addEventListener('click', (e) => {
  navigator.clipboard.writeText(window.location.href);
  const original = e.target.textContent;
  e.target.textContent = '✓ Link Copied!';
  setTimeout(() => (e.target.textContent = original), 1800);
});

const qrModal = document.getElementById('qrModal');
const qrContainer = document.getElementById('qrContainer');

document.getElementById('qrBtn').addEventListener('click', () => {
  qrContainer.innerHTML = '';
  new QRCode(qrContainer, {
    text: window.location.href,
    width: 180,
    height: 180
  });
  document.getElementById('qrUrlText').textContent = window.location.href;
  qrModal.classList.remove('hidden');
});

document.getElementById('closeQrBtn').addEventListener('click', () => {
  qrModal.classList.add('hidden');
});