/* =========================================================
   FlickSync — Floating Document Picture-in-Picture Cameras
   ========================================================= */
(function () {
  let pipWindow = null;
  let pipSyncInterval = null;
  let pipConfig = null;

  function closeFloatingCameraWindow() {
    if (pipSyncInterval) {
      clearInterval(pipSyncInterval);
      pipSyncInterval = null;
    }
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }
    pipWindow = null;

    const btn = document.getElementById('pipCamerasBtn');
    if (btn) btn.classList.add('hidden');
  }

  async function openFloatingCameraWindow() {
    if (!pipConfig) return;

    if (!('documentPictureInPicture' in window)) {
      pipConfig.showToast('Floating camera window requires Desktop Chrome or Edge.');
      return;
    }
    if (pipWindow && !pipWindow.closed) {
      pipWindow.focus();
      return;
    }

    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 340,
        height: 220
      });

      const doc = pipWindow.document;

      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${window.location.origin}/floating-pip.css`;
      doc.head.appendChild(link);

      doc.body.className = 'pip-body';

      const bar = doc.createElement('div');
      bar.className = 'pip-bar';

      const micBtn = doc.createElement('button');
      micBtn.className = 'pip-btn';

      const camBtn = doc.createElement('button');
      camBtn.className = 'pip-btn';

      const stopBtn = doc.createElement('button');
      stopBtn.className = 'pip-stop-btn';
      stopBtn.textContent = '⏹ Stop';

      const syncPipControlLabels = () => {
        const localStream = pipConfig.getLocalCallStream();
        const aTrack = localStream?.getAudioTracks()[0];
        const vTrack = localStream?.getVideoTracks()[0];

        const micOff = Boolean(aTrack && !aTrack.enabled);
        const camOff = Boolean(vTrack && !vTrack.enabled);

        micBtn.textContent = micOff ? '🔇 Muted' : '🎤 Mic';
        micBtn.classList.toggle('is-off', micOff);

        camBtn.textContent = camOff ? '🚫 Off' : '📷 Cam';
        camBtn.classList.toggle('is-off', camOff);
      };
      syncPipControlLabels();

      micBtn.onclick = () => {
        document.getElementById('toggleMicBtn')?.click();
        syncPipControlLabels();
      };
      camBtn.onclick = () => {
        document.getElementById('toggleCamBtn')?.click();
        syncPipControlLabels();
      };
      stopBtn.onclick = () => {
        pipConfig.onStopShare();
        closeFloatingCameraWindow();
      };

      bar.appendChild(micBtn);
      bar.appendChild(camBtn);
      bar.appendChild(stopBtn);
      doc.body.appendChild(bar);

      const grid = doc.createElement('div');
      grid.className = 'pip-grid';
      doc.body.appendChild(grid);

      const renderedPipStreams = new Map();

      const syncPipCameras = () => {
        if (!pipWindow || pipWindow.closed) return;
        syncPipControlLabels();

        const remoteVideos = pipConfig.getRemoteCallVideos();
        const peerNames = pipConfig.getPeerDisplayNames();
        const localStream = pipConfig.getLocalCallStream();
        const myName = pipConfig.getProfileName();

        const desired = [];
        Object.entries(remoteVideos).forEach(([id, vidEl]) => {
          if (vidEl?.srcObject) {
            desired.push({
              id,
              name: peerNames[id] || `Friend (${id.slice(0, 4)})`,
              stream: vidEl.srcObject
            });
          }
        });
        if (localStream) {
          desired.push({
            id: 'local',
            name: myName ? `${myName} (You)` : 'You',
            stream: localStream
          });
        }

        const activeIds = new Set(desired.map((d) => d.id));
        for (const [id, tile] of renderedPipStreams.entries()) {
          if (!activeIds.has(id)) {
            tile.remove();
            renderedPipStreams.delete(id);
          }
        }

        desired.forEach(({ id, name, stream }) => {
          let tile = renderedPipStreams.get(id);
          if (!tile) {
            tile = doc.createElement('div');
            tile.className = 'pip-tile';

            const v = doc.createElement('video');
            v.autoplay = true;
            v.playsInline = true;
            v.muted = true;
            if (id === 'local') {
              v.classList.add('is-local-mirror');
            }

            const badge = doc.createElement('span');
            badge.className = 'pip-badge';
            badge.textContent = name;

            tile.appendChild(v);
            tile.appendChild(badge);
            grid.appendChild(tile);
            renderedPipStreams.set(id, tile);
          }

          const videoEl = tile.querySelector('video');
          if (videoEl.srcObject !== stream) {
            videoEl.srcObject = stream;
            videoEl.play().catch(() => {});
          }
          tile.querySelector('span').textContent = name;
        });
      };

      syncPipCameras();
      pipSyncInterval = setInterval(syncPipCameras, 1000);

      pipWindow.addEventListener('pagehide', () => {
        if (pipSyncInterval) {
          clearInterval(pipSyncInterval);
          pipSyncInterval = null;
        }
        pipWindow = null;
      });
    } catch (err) {
      console.warn('Floating PiP window blocked or unavailable:', err);
    }
  }

  window.FlickSyncFloatingPiP = {
    init(config) {
      pipConfig = config;
      const btn = document.getElementById('pipCamerasBtn');
      if (btn) {
        btn.addEventListener('click', openFloatingCameraWindow);
      }
    },
    open: openFloatingCameraWindow,
    close: closeFloatingCameraWindow,
    showButton() {
      const btn = document.getElementById('pipCamerasBtn');
      if (btn && 'documentPictureInPicture' in window) {
        btn.classList.remove('hidden');
      }
    }
  };
})();