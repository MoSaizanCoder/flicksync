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
      doc.body.style.cssText =
        'margin:0;background:#060913;color:#f1f5f9;font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden;';

      // Top compact controls bar (Mic, Cam, Stop Share)
      const bar = doc.createElement('div');
      bar.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:6px 8px;background:#0f172a;border-bottom:1px solid #1e293b;flex-shrink:0;';

      const micBtn = doc.createElement('button');
      const camBtn = doc.createElement('button');
      const stopBtn = doc.createElement('button');

      const btnStyle =
        'flex:1;background:#1e293b;color:#f8fafc;border:1px solid #334155;border-radius:6px;padding:4px 6px;font-size:11px;font-weight:600;cursor:pointer;';
      micBtn.style.cssText = btnStyle;
      camBtn.style.cssText = btnStyle;
      stopBtn.style.cssText =
        'background:#e11d48;color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;';
      stopBtn.textContent = '⏹ Stop';

      const syncPipControlLabels = () => {
        const localStream = pipConfig.getLocalCallStream();
        const aTrack = localStream?.getAudioTracks()[0];
        const vTrack = localStream?.getVideoTracks()[0];

        micBtn.textContent = aTrack && !aTrack.enabled ? '🔇 Muted' : '🎤 Mic';
        micBtn.style.background = aTrack && !aTrack.enabled ? '#e11d48' : '#1e293b';
        camBtn.textContent = vTrack && !vTrack.enabled ? '🚫 Off' : '📷 Cam';
        camBtn.style.background = vTrack && !vTrack.enabled ? '#e11d48' : '#1e293b';
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

      // Live cameras grid container
      const grid = doc.createElement('div');
      grid.style.cssText =
        'flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;padding:6px;overflow-y:auto;align-content:center;';
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

        const activeIds = new Set(desired.map(d => d.id));
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
            tile.style.cssText =
              'position:relative;background:#000;border:1px solid #334155;border-radius:8px;overflow:hidden;aspect-ratio:16/10;';

            const v = doc.createElement('video');
            v.autoplay = true;
            v.playsInline = true;
            v.muted = true; // Audio plays from the main tab to avoid echo
            v.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';

            const badge = doc.createElement('span');
            badge.style.cssText =
              'position:absolute;bottom:4px;left:4px;background:rgba(2,6,23,0.8);color:#e2e8f0;font-size:10px;padding:2px 6px;border-radius:4px;';
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