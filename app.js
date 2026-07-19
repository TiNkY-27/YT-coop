/* ===== STATE ===== */
let player = null;
let playerReady = false;
let store = { playlists: {} };
let activePlaylistId = null;
let activeSourceIdx = 0;
let advancingSource = false;
let trackCache = {}; // {videoId: {title, author}}
let lastSourceTotal = 0;
let isPlaying = false;

/* ===== DOM REFS ===== */
const $ = id => document.getElementById(id);
const statusText = $('status-text');
const statusBar = $('status-bar');
const trackTitle = $('track-title');
const trackChannel = $('track-channel');
const progressText = $('progress-text');
const trackListEl = $('track-list');
const trackSection = $('track-section');
const playlistListEl = $('playlist-list');
const sourceListEl = $('source-list');
const sourceUrlInput = $('source-url-input');
const addSourceBtn = $('add-source-btn');
const newPlaylistName = $('new-playlist-name');
const createPlaylistBtn = $('create-playlist-btn');
const playBtn = $('play-btn');
const prevBtn = $('prev-btn');
const nextBtn = $('next-btn');
const muteBtn = $('mute-btn');
const volumeSlider = $('volume-slider');
const playIcon = $('play-icon');

/* ===== STORE ===== */
function loadStore() {
  try {
    const raw = localStorage.getItem('corridoPlaylists');
    if (raw) store = JSON.parse(raw);
  } catch {}
  if (!store.playlists) store.playlists = {};
}

function saveStore() {
  localStorage.setItem('corridoPlaylists', JSON.stringify(store));
}

/* ===== URL PARSING ===== */
function parseUrl(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get('list');
    if (list) return { type: 'playlist', id: list };
    const v = u.searchParams.get('v');
    if (v) return { type: 'video', id: v };
    if (u.hostname === 'youtu.be' || u.hostname === 'www.youtu.be') {
      const id = u.pathname.slice(1);
      if (id) return { type: 'video', id };
    }
    return null;
  } catch {
    return null;
  }
}

/* ===== RENDER ===== */
function renderPlaylistList() {
  const ids = Object.keys(store.playlists);
  if (ids.length === 0) {
    playlistListEl.innerHTML = '<div class="empty-state">No hay playlists aún</div>';
    return;
  }
  playlistListEl.innerHTML = '';
  ids.forEach(id => {
    const pl = store.playlists[id];
    const div = document.createElement('button');
    div.className = 'playlist-item' + (id === activePlaylistId ? ' active' : '');
    div.innerHTML = `
      <span class="pl-name">${escHtml(pl.name)}</span>
      <span class="pl-count">${pl.sources.length}</span>
      <span class="pl-play" data-id="${id}">&#9654;</span>
      <span class="pl-delete" data-id="${id}">&times;</span>
    `;
    div.addEventListener('click', e => {
      if (e.target.closest('.pl-play') || e.target.closest('.pl-delete')) return;
      selectPlaylist(id);
    });
    div.querySelector('.pl-play').addEventListener('click', e => {
      e.stopPropagation();
      playPlaylist(id);
    });
    div.querySelector('.pl-delete').addEventListener('click', e => {
      e.stopPropagation();
      deletePlaylist(id);
    });
    playlistListEl.appendChild(div);
  });
}

function renderSourceList() {
  sourceListEl.innerHTML = '';
  if (!activePlaylistId) {
    sourceListEl.innerHTML = '<div class="empty-state">Selecciona una playlist</div>';
    return;
  }
  const pl = store.playlists[activePlaylistId];
  if (!pl || pl.sources.length === 0) {
    sourceListEl.innerHTML = '<div class="empty-state">Agrega links de YT Music</div>';
    return;
  }
  pl.sources.forEach((url, i) => {
    const li = document.createElement('li');
    li.className = 'source-item';
    li.innerHTML = `
      <span class="src-url" title="${escHtml(url)}">${escHtml(url)}</span>
      <span class="src-del" data-idx="${i}">&times;</span>
    `;
    li.querySelector('.src-del').addEventListener('click', () => removeSource(i));
    sourceListEl.appendChild(li);
  });
}

function renderTrackList() {
  if (!player || !playerReady) {
    trackSection.style.display = 'none';
    return;
  }
  try {
    const list = player.getPlaylist();
    if (!list || list.length === 0) {
      trackSection.style.display = 'none';
      return;
    }
    trackSection.style.display = 'block';
    trackListEl.innerHTML = '';
    lastSourceTotal = list.length;
    list.forEach((vid, i) => {
      const cached = trackCache[vid];
      const li = document.createElement('li');
      li.dataset.index = i;
      const title = cached ? escHtml(cached.title) : 'Cargando...';
      const channel = cached ? escHtml(cached.author) : '';
      li.innerHTML = `
        <span class="idx">${i + 1}</span>
        <span class="tt-title">${title}</span>
        <span class="tt-channel">${channel}</span>
      `;
      trackListEl.appendChild(li);
    });
    highlightCurrentTrack();
  } catch {
    trackSection.style.display = 'none';
  }
}

function highlightCurrentTrack() {
  if (!player || !playerReady) return;
  try {
    const idx = player.getPlaylistIndex();
    const items = trackListEl.querySelectorAll('li');
    items.forEach((li, i) => {
      li.classList.toggle('active', i === idx);
      if (i === idx) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  } catch {}
}

function updateTrackInfo() {
  if (!player || !playerReady) return;
  try {
    const data = player.getVideoData();
    const idx = player.getPlaylistIndex();
    const list = player.getPlaylist();
    const total = list ? list.length : 0;

    if (data && data.title) {
      trackTitle.textContent = data.title;
      trackChannel.textContent = data.author || '—';
      if (data.video_id) {
        trackCache[data.video_id] = { title: data.title, author: data.author };
        updateTrackListItem(data.video_id, data.title, data.author);
      }
    }
    if (total > 0) {
      const displayIdx = idx >= 0 ? idx + 1 : '?';
      progressText.textContent = `${displayIdx} / ${total}`;
    }
    highlightCurrentTrack();
  } catch {}
}

function updateTrackListItem(videoId, title, author) {
  const list = player && player.getPlaylist ? player.getPlaylist() : [];
  if (!list) return;
  const idx = list.indexOf(videoId);
  if (idx === -1) return;
  const items = trackListEl.querySelectorAll('li');
  if (items[idx]) {
    items[idx].querySelector('.tt-title').textContent = title;
    items[idx].querySelector('.tt-channel').textContent = author || '';
  }
}

/* ===== PLAYLIST CRUD ===== */
function selectPlaylist(id) {
  activePlaylistId = id;
  renderPlaylistList();
  renderSourceList();
  store.activePlaylistId = id;
  saveStore();
}

function createPlaylist(name) {
  const trimmed = name.trim();
  if (!trimmed) { setStatus('Escribe un nombre para la playlist', 'error'); return; }
  const id = 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  store.playlists[id] = { name: trimmed, sources: [] };
  saveStore();
  selectPlaylist(id);
  newPlaylistName.value = '';
  setStatus(`Playlist "${trimmed}" creada`, 'success');
}

function deletePlaylist(id) {
  if (!confirm(`¿Eliminar "${store.playlists[id].name}"?`)) return;
  delete store.playlists[id];
  if (activePlaylistId === id) activePlaylistId = null;
  saveStore();
  renderPlaylistList();
  renderSourceList();
  setStatus('Playlist eliminada', '');
}

function addSource(url) {
  const trimmed = url.trim();
  if (!trimmed) { setStatus('Pega un link primero', 'error'); return; }
  const parsed = parseUrl(trimmed);
  if (!parsed) { setStatus('Link no válido (debe ser de YouTube)', 'error'); return; }
  if (!activePlaylistId) { setStatus('Selecciona o crea una playlist primero', 'error'); return; }
  store.playlists[activePlaylistId].sources.push(trimmed);
  saveStore();
  renderSourceList();
  renderPlaylistList();
  sourceUrlInput.value = '';
  setStatus('Fuente agregada', 'success');
}

function removeSource(idx) {
  if (!activePlaylistId) return;
  store.playlists[activePlaylistId].sources.splice(idx, 1);
  saveStore();
  renderSourceList();
  renderPlaylistList();
}

/* ===== PLAYBACK ===== */
function playPlaylist(id) {
  const pl = store.playlists[id];
  if (!pl || pl.sources.length === 0) {
    setStatus('Esta playlist no tiene fuentes', 'error');
    return;
  }
  activePlaylistId = id;
  activeSourceIdx = 0;
  selectPlaylist(id);
  loadSource(0);
}

function loadSource(idx) {
  if (!player || !playerReady) {
    setStatus('El reproductor no está listo', 'error');
    return;
  }
  const pl = store.playlists[activePlaylistId];
  if (!pl || idx >= pl.sources.length) {
    setStatus('Fin de la playlist', '');
    return;
  }
  activeSourceIdx = idx;
  const url = pl.sources[idx];
  const parsed = parseUrl(url);
  if (!parsed) {
    setStatus('Fuente inválida, saltando...', 'error');
    loadSource(idx + 1);
    return;
  }
  setStatus(`Cargando fuente ${idx + 1}/${pl.sources.length}...`, '');

  if (parsed.type === 'playlist') {
    player.loadPlaylist({ list: parsed.id, listType: 'playlist', index: 0 });
  } else {
    player.loadPlaylist({ playlist: [parsed.id], index: 0 });
  }
  player.playVideo();
}

function loadNextSource() {
  advancingSource = true;
  loadSource(activeSourceIdx + 1);
  setTimeout(() => { advancingSource = false; }, 500);
}

/* ===== CONTROLS ===== */
function togglePlay() {
  if (!player || !playerReady) return;
  if (isPlaying) {
    player.pauseVideo();
  } else {
    player.playVideo();
  }
}

function nextTrack() {
  if (!player || !playerReady) return;
  const list = player.getPlaylist();
  const idx = player.getPlaylistIndex();
  if (list && idx >= 0 && idx < list.length - 1) {
    player.nextVideo();
  } else {
    loadNextSource();
  }
}

function prevTrack() {
  if (!player || !playerReady) return;
  const idx = player.getPlaylistIndex();
  if (idx > 0) {
    player.previousVideo();
  } else {
    // Go to previous source's last track
    if (activeSourceIdx > 0) {
      const prev = activeSourceIdx - 1;
      loadSource(prev);
    }
  }
}

/* ===== YT PLAYER EVENTS ===== */
function handlePlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    isPlaying = true;
    updatePlayIcon();
    updateTrackInfo();
    setStatus('Reproduciendo', 'success');
  } else if (event.data === YT.PlayerState.PAUSED) {
    isPlaying = false;
    updatePlayIcon();
    setStatus('Pausado', '');
  } else if (event.data === YT.PlayerState.ENDED) {
    if (!advancingSource) {
      const list = player.getPlaylist();
      const idx = player.getPlaylistIndex();
      if (!list || idx < 0 || idx >= list.length - 1) {
        loadNextSource();
      }
    }
  } else if (event.data === YT.PlayerState.CUED) {
    renderTrackList();
    updateTrackInfo();
    if (!isPlaying) {
      player.playVideo();
    }
  }
}

function handlePlayerError(event) {
  const msgs = {
    2: 'URL inválida', 5: 'Error del reproductor',
    100: 'Video no encontrado', 101: 'No permite embebido',
    150: 'No permite embebido',
  };
  setStatus(msgs[event.data] || 'Error ' + event.data, 'error');
}

function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '100%', width: '100%',
    playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        const vol = parseInt(localStorage.getItem('corridoVolume')) || 80;
        player.setVolume(vol);
        volumeSlider.value = vol;
        setStatus('Listo — crea o selecciona una playlist', '');
        if (store.activePlaylistId && store.playlists[store.activePlaylistId]) {
          selectPlaylist(store.activePlaylistId);
        }
      },
      onStateChange: handlePlayerStateChange,
      onError: handlePlayerError,
    },
  });
}

function updatePlayIcon() {
  if (isPlaying) {
    playIcon.setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
  } else {
    playIcon.setAttribute('d', 'M8 5v14l11-7z');
  }
}

/* ===== MISC ===== */
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function setStatus(msg, type) {
  statusBar.className = 'status-bar' + (type ? ' ' + type : '');
  statusText.textContent = msg;
}

function loadYTAPI() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

/* ===== EVENTS ===== */
createPlaylistBtn.addEventListener('click', () => createPlaylist(newPlaylistName.value));
newPlaylistName.addEventListener('keydown', e => { if (e.key === 'Enter') createPlaylist(newPlaylistName.value); });

addSourceBtn.addEventListener('click', () => addSource(sourceUrlInput.value));
sourceUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addSource(sourceUrlInput.value); });

playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', prevTrack);
nextBtn.addEventListener('click', nextTrack);

muteBtn.addEventListener('click', () => {
  if (!player || !playerReady) return;
  if (player.isMuted()) {
    player.unMute();
    volumeSlider.value = player.getVolume();
  } else {
    player.mute();
    volumeSlider.value = 0;
  }
});

volumeSlider.addEventListener('input', () => {
  if (!player || !playerReady) return;
  const v = parseInt(volumeSlider.value);
  player.setVolume(v);
  localStorage.setItem('corridoVolume', v);
  if (player.isMuted()) player.unMute();
});

/* ===== KEYBOARD SHORTCUTS ===== */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowRight') nextTrack();
  if (e.key === 'ArrowLeft') prevTrack();
  if (e.key === 'm') muteBtn.click();
});

/* ===== INIT ===== */
loadStore();
if (store.activePlaylistId && store.playlists[store.activePlaylistId]) {
  activePlaylistId = store.activePlaylistId;
}
renderPlaylistList();
renderSourceList();
loadYTAPI();
