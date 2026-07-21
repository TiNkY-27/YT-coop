let supabase = null;
const Player = window.Player;
let userId = null;
let user = null;
let roomCode = '';
let room = null;
let isAdmin = false;
let canControl = false;
let hasQueue = false;
let lastVideoId = null;

// Identificador unico de este cliente/pestana. Se incluye en cada emit a
// Supabase para registro/trazabilidad, pero YA NO se usa para descartar eco:
// todo el flujo de aplicacion pasa por un unico camino (renderRoomState) sin
// importar de quien provenga el cambio.
const CLIENT_ID = (function () {
  try {
    const stored = sessionStorage.getItem('ytsync_client_id');
    if (stored) return stored;
  } catch (e) {}
  const fresh = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { sessionStorage.setItem('ytsync_client_id', fresh); } catch (e) {}
  return fresh;
})();
let stateTimer = null;
let progressTimer = null;
let previewKind = null;
let previewId = null;
let queueCache = [];
let participantsCache = {};
let themeIsDark = false;
let currentVolume = 100;

// === Sync / state control ===
// settleUntil: ventana de asentamiento. Mientras este abierta, los rebotes del
// IFrame Player (BUFFERING/PLAYING/PAUSED) se descartan en onPlayerStateChange
// para no generar autosync de un cambio que nosotros mismos disparamos.
let settleUntil = 0;
const SETTLE_WINDOW_MS = 600;
let lastSentPlaybackTime = 0;

const els = {};

const YT_THUMB_BASE = 'https://img.youtube.com/vi';

function ensureSupabase() {
  supabase = window.supabase;
  if (!supabase) {
    alert('Supabase no esta configurado. Revisa js/supabase-client.js');
    throw new Error('Supabase no configurado');
  }
}

async function ensureAuth(username) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) console.warn('Error obteniendo sesion:', error.message);

  if (!session) {
    const { data, error: signErr } = await supabase.auth.signInAnonymously({
      options: { data: { username: username || 'Anonimo' } }
    });
    if (signErr) throw signErr;
    user = data.user;
    userId = user.id;
  } else {
    user = session.user;
    userId = user.id;
    if (username && username !== user.user_metadata?.username) {
      const { error: upErr } = await supabase.auth.updateUser({
        data: { username }
      });
      if (upErr) console.warn('No se pudo actualizar username:', upErr.message);
    }
  }
  return user;
}
function getUsername() {
  if (!user) return '';
  return user.user_metadata?.username || localStorage.getItem('username') || 'Anonimo';
}

function extractPlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  input = input.trim();
  if (!input) return null;

  if (/^[A-Za-z0-9_-]+$/.test(input)) {
    return input.startsWith('VL') ? input.slice(2) : input;
  }

  const listMatch = input.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (listMatch) {
    const id = listMatch[1];
    return id.startsWith('VL') ? id.slice(2) : id;
  }

  const plMatch = input.match(/\/playlist\?list=([A-Za-z0-9_-]+)/);
  if (plMatch) {
    return plMatch[1].startsWith('VL') ? plMatch[1].slice(2) : plMatch[1];
  }

  console.warn('[extractPlaylistId] no se pudo extraer ID de:', input);
  return null;
}

function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  input = input.trim();
  if (!input) return null;

  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

  const yMatch = input.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (yMatch) return yMatch[1];

  const vMatch = input.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (vMatch) return vMatch[1];

  const sMatch = input.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (sMatch) return sMatch[1];

  const eMatch = input.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (eMatch) return eMatch[1];

  console.warn('[extractVideoId] no se pudo extraer ID de:', input);
  return null;
}

function classifyInput(input) {
  if (!input) return { kind: null, id: null };
  const pid = extractPlaylistId(input);
  if (pid) return { kind: 'playlist', id: pid };
  const vid = extractVideoId(input);
  if (vid) return { kind: 'video', id: vid };
  return { kind: null, id: null };
}

function getPlaylistThumbnail(playlistId) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 68'>` +
    `<rect width='120' height='68' fill='%2330303a'/>` +
    `<g fill='%23a0a0b0'>` +
    `<rect x='20' y='18' width='42' height='32' rx='3'/>` +
    `<rect x='28' y='26' width='26' height='3' rx='1.5'/>` +
    `<rect x='28' y='32' width='20' height='3' rx='1.5'/>` +
    `<rect x='28' y='38' width='22' height='3' rx='1.5'/>` +
    `<circle cx='86' cy='34' r='14' fill='%23ff3e3e'/>` +
    `<polygon points='82,28 82,40 94,34' fill='white'/>` +
    `</g></svg>`;
  return `data:image/svg+xml;utf8,${svg.replace(/\n\s*/g, '')}`;
}

function formatTime(seconds) {
  const s = Math.floor(seconds || 0);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m + ':' + String(rem).padStart(2, '0');
}

function bindElements() {
  els.title = document.getElementById('room-title');
  els.code = document.getElementById('room-code');
  els.shareBtn = document.getElementById('share-btn');
  els.participants = document.getElementById('participants-list');
  els.playerContainer = document.getElementById('player-container');
  els.playBtn = document.getElementById('play-btn');
  els.pauseBtn = document.getElementById('pause-btn');
  els.prevBtn = document.getElementById('prev-btn');
  els.nextBtn = document.getElementById('next-btn');
  els.syncBtn = document.getElementById('sync-btn');
  els.volume = document.getElementById('volume');
  els.volumeValue = document.getElementById('volume-value');
  els.progress = document.getElementById('progress');
  els.progressCurrent = document.getElementById('progress-current');
  els.progressTotal = document.getElementById('progress-total');
  els.playerControls = document.getElementById('player-controls');
  els.volumeRow = document.getElementById('volume-row');
  els.progressRow = document.getElementById('progress-row');
  els.modeToggle = document.getElementById('mode-toggle');
  els.modeTextAdmin = document.getElementById('mode-text-admin');
  els.modeText = document.getElementById('mode-text');
  els.modeDisplay = document.getElementById('mode-display');
  els.adminPanel = document.getElementById('admin-panel');
  els.savedSelect = document.getElementById('saved-playlists');
  els.loadSavedBtn = document.getElementById('load-saved-btn');
  els.urlInput = document.getElementById('playlist-url');
  els.previewBox = document.getElementById('preview-box');
  els.previewName = document.getElementById('preview-name');
  els.previewId = document.getElementById('preview-id');
  els.previewThumb = document.querySelector('.preview-thumb');
  els.addToQueue = document.getElementById('add-to-queue');
  els.saveToProfile = document.getElementById('save-to-profile');
  els.queueList = document.getElementById('queue-list');
  els.currentInfo = document.getElementById('current-info');
  els.nowPlaying = document.getElementById('now-playing');
  els.resumeOverlay = document.getElementById('resume-overlay');
  els.status = document.getElementById('status-message');
  els.usernameInput = document.getElementById('username-input');
  els.themeToggle = document.getElementById('theme-toggle');
  els.iconSun = document.getElementById('icon-sun');
  els.iconMoon = document.getElementById('icon-moon');
  els.participantsCount = document.getElementById('participants-count');
}

function setStatus(message) {
  if (els.status) els.status.textContent = message;
  console.log(message);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

async function getRoomIdByCode(code) {
  const { data, error } = await supabase.rpc('get_room_id_by_code', {
    room_code: code
  });
  if (error || !data) {
    setStatus('Sala no encontrada o inactiva.');
    throw new Error('Sala no encontrada');
  }
  return data;
}

async function loadRoom() {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('code', roomCode)
    .single();

  if (error || !data || !data.active) {
    setStatus('Sala no encontrada o inactiva.');
    throw new Error('Sala no encontrada');
  }
  room = data;
  isAdmin = room.admin_id === userId;
  canControl = isAdmin || room.is_open;

  if (els.title) els.title.textContent = room.name || 'Sala compartida';
  if (els.code) els.code.textContent = roomCode;
}

async function joinParticipant(roomId) {
  const username = getUsername();
  const { data: existing } = await supabase
    .from('participants')
    .select('id, is_admin')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    if (isAdmin && !existing.is_admin) {
      await supabase.from('participants').update({ is_admin: true }).eq('id', existing.id);
    }
    return;
  }

  const { error } = await supabase.from('participants').insert({
    room_id: roomId,
    user_id: userId,
    username,
    is_admin: isAdmin
  });
  if (error) console.warn('Error uniendose a la sala:', error.message);
}

async function loadParticipants() {
  const { data, error } = await supabase
    .from('participants')
    .select('*')
    .eq('room_id', room.id)
    .order('joined_at', { ascending: true });

  if (error) {
    console.warn('Error cargando participantes:', error.message);
    return;
  }

  participantsCache = {};
  (data || []).forEach((p) => { participantsCache[p.user_id] = p.username; });

  els.participants.innerHTML = data
    .map(
      (p) =>
        `<li class="participant ${p.is_admin ? 'admin' : ''}">` +
        `<span class="name">${escapeHtml(p.username)}</span>` +
        `${p.is_admin ? ' <span class="badge">admin</span>' : ''}` +
        `</li>`
    )
    .join('');

  if (els.participantsCount) els.participantsCount.textContent = (data || []).length;
}

async function loadUserPlaylists() {
  const { data, error } = await supabase
    .from('playlists')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('Error cargando playlists:', error.message);
    return;
  }

  els.savedSelect.innerHTML = '<option value="">Selecciona una playlist guardada...</option>' +
    data.map((p) => `<option value="${escapeHtml(p.playlist_id)}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('');
}

async function loadQueue() {
  const { data, error } = await supabase
    .from('queue')
    .select('*')
    .eq('room_id', room.id)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('Error cargando cola:', error.message);
    return [];
  }

  queueCache = data || [];
  renderQueue();
  updateHasQueue();
  return queueCache;
}

function renderQueue() {
  if (!els.queueList) return;

  if (queueCache.length === 0) {
    els.queueList.innerHTML = '<li class="queue-empty">La cola está vacía.</li>';
    return;
  }

  const musicIcon = '<svg class="qi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';

  els.queueList.innerHTML = queueCache.map(function (item, i) {
    const isActive = room && room.current_queue_index === i;
    const addedBy = participantsCache[item.created_by] || 'alguien';
    const sub = isActive
      ? '<span class="qi-sub">sonando</span>'
      : `<span class="qi-sub">${escapeHtml(addedBy)}</span>`;
    return `<li class="queue-item ${isActive ? 'is-active' : ''}" data-index="${i}">` +
      musicIcon +
      `<span class="qi-name">${escapeHtml(item.title || ('Video ' + item.video_id))}</span>` +
      sub +
      `</li>`;
  }).join('');
}

function updateHasQueue() {
  if (!room) return;
  hasQueue = (room.current_video_id != null) || queueCache.length > 0;
}

function updatePermissionsUI() {
  if (!room) return;
  canControl = isAdmin || room.is_open;

  els.adminPanel.classList.toggle('hidden', !isAdmin);
  document.body.classList.toggle('is-admin', isAdmin);

  const modeLabelText = room.is_open ? 'Abierto' : 'Restringido';
  if (els.modeTextAdmin) els.modeTextAdmin.textContent = modeLabelText;
  if (els.modeText) els.modeText.textContent = modeLabelText;

  const controls = [els.playBtn, els.pauseBtn, els.prevBtn, els.nextBtn, els.syncBtn, els.progress];
  controls.forEach((el) => {
    if (el) el.disabled = !canControl || !hasQueue;
  });

  if (els.volume) els.volume.disabled = !Player.isReady();
  if (els.volumeValue) els.volumeValue.textContent = els.volume ? els.volume.value : '0';

  if (els.modeToggle) {
    els.modeToggle.checked = room.is_open;
    if (!isAdmin) els.modeToggle.disabled = true;
  }

  if (els.previewBox && !els.previewBox.classList.contains('hidden')) {
    if (els.addToQueue) els.addToQueue.disabled = !canControl;
  }
}

function currentTargetTime(r) {
  const base = r.playback_time || 0;
  if (r.player_state !== 'playing') return base;
  const elapsed = (Date.now() - new Date(r.updated_at).getTime()) / 1000;
  return base + elapsed;
}

// Emite un autosync del estado actual del player (playback_time + estado).
// Usado SOLO por el timer periodico y por onPlayerStateChange para reflejar
// cambios genuinos del IFrame Player (pausa por buffering, etc.).
// Las acciones del usuario (botones) NO usan esta funcion: escriben directo
// a Supabase con el patch exacto y dejan que renderRoomState aplique todo.
async function emitRoomState(playerState) {
  if (!room || !Player.isReady()) return;

  const nowIso = new Date().toISOString();
  const finalState = playerState || Player.getStateName();
  const finalTime = Player.getCurrentTime();

  const patch = {
    playback_time: finalTime,
    player_state: finalState,
    current_video_id: Player.getVideoId(),
    client_id: CLIENT_ID,
    updated_at: nowIso
  };

  lastSentPlaybackTime = finalTime;
  console.log('[SYNC][EMIT]', {
    state: finalState,
    videoId: Player.getVideoId(),
    playbackTime: finalTime
  });

  const { error } = await supabase.from('rooms').update(patch).eq('id', room.id);
  if (error) console.warn('Error enviando estado:', error.message);
}

// =====================================================================
// renderRoomState(newRoom): UNICO punto de aplicacion del estado.
//
// Recibe SIEMPRE el estado completo de la sala (de Realtime o de un reload
// manual). Actualiza el objeto room en memoria, refresca la UI y aplica
// los cambios al reproductor. No distingue si el cambio es propio o
// remoto: el mismo camino se usa en ambos casos.
// =====================================================================
function renderRoomState(newRoom) {
  if (!room || !newRoom) return;

  const targetTime = currentTargetTime(newRoom);
  const videoChanged = newRoom.current_video_id !== room.current_video_id;
  const stateChanged = newRoom.player_state !== room.player_state;

  console.log('[SYNC][RENDER]', {
    videoChanged: videoChanged,
    stateChanged: stateChanged,
    targetState: newRoom.player_state,
    targetVideoId: newRoom.current_video_id,
    targetTime: targetTime
  });

  // 1) Actualizar el objeto room (single source of truth).
  Object.assign(room, newRoom);

  // 2) Refrescar UI inmediatamente.
  updateHasQueue();
  updatePermissionsUI();
  updateNowPlaying();
  renderQueue();

  if (!Player.isReady()) return;

  // 3) Aplicar al reproductor. Abrimos ventana de asentamiento para que los
  // rebotes del IFrame Player no disparen autosync.
  settleUntil = Date.now() + SETTLE_WINDOW_MS;
  suppressPlayerEvents(SETTLE_WINDOW_MS);

  if (videoChanged) {
    if (newRoom.current_video_id === null) {
      Player.stop();
      lastVideoId = null;
      updateProgress();
    } else {
      Player.loadVideo(newRoom.current_video_id, targetTime);
      lastVideoId = newRoom.current_video_id;
      if (newRoom.player_state === 'playing') Player.play();
      else Player.pause();
    }
  } else {
    const drift = Math.abs((Player.getCurrentTime() || 0) - targetTime);
    if (drift > 1.5) Player.seekTo(targetTime, true);
    if (stateChanged) {
      if (newRoom.player_state === 'playing') Player.play();
      else Player.pause();
    }
  }
}

function updateNowPlaying() {
  const titleEl = els.currentInfo;
  const statusEl = els.nowPlaying;

  if (!room || !room.current_video_id) {
    titleEl.textContent = 'Sin canciones en la cola';
    statusEl.textContent = 'Agregá una playlist o un video para empezar.';
    statusEl.classList.remove('hidden');
    hideResume();
    return;
  }

  const idx = room.current_queue_index || 0;
  const item = queueCache[idx];
  const title = item ? (item.title || ('Video ' + item.video_id)) : ('Video ' + room.current_video_id);

  titleEl.textContent = title;

  let stateLabel = '';
  if (Player.isReady()) {
    const s = Player.getState();
    if (s === YT.PlayerState.PLAYING) {
      stateLabel = 'Reproduciendo';
    } else if (s === YT.PlayerState.PAUSED) {
      stateLabel = 'Pausa';
    } else if (s === YT.PlayerState.BUFFERING) {
      stateLabel = 'Cargando...';
    } else if (s === YT.PlayerState.ENDED) {
      stateLabel = 'Finalizado';
    } else {
      stateLabel = (room.player_state === 'playing') ? 'Listo para reproducir' : 'En pausa';
    }
  } else {
    stateLabel = (room.player_state === 'playing') ? 'Cargando reproductor...' : 'En pausa';
  }

  statusEl.textContent = stateLabel;
  statusEl.classList.remove('hidden');

  if (room.player_state === 'playing' && Player.isReady()) {
    const s = Player.getState();
    if (s !== YT.PlayerState.PLAYING && s !== YT.PlayerState.BUFFERING) {
      showResume();
    } else {
      hideResume();
    }
  } else {
    hideResume();
  }
}

function showResume() {
  if (els.resumeOverlay) els.resumeOverlay.classList.remove('hidden');
}
function hideResume() {
  if (els.resumeOverlay) els.resumeOverlay.classList.add('hidden');
}
function showResumeIfBlocked() {
  if (!Player.isReady()) return;
  if (Player.getState() === YT.PlayerState.PLAYING) {
    hideResume();
    return;
  }
  showResume();
}

function updateProgress(forceDuration) {
  const duration = forceDuration || Player.getDuration();
  const current = Player.getCurrentTime();
  if (els.progress) {
    els.progress.max = Math.floor(duration);
    els.progress.value = Math.floor(current);
    els.progress.disabled = !canControl || !hasQueue;
  }
  if (els.progressCurrent) els.progressCurrent.textContent = formatTime(current);
  if (els.progressTotal) els.progressTotal.textContent = formatTime(duration);
}

let ignoreEventsUntil = 0;
function suppressPlayerEvents(ms) {
  ignoreEventsUntil = Date.now() + (ms || 500);
}
function ignoringEvents() {
  return Date.now() < ignoreEventsUntil;
}

function onPlayerStateChange(stateCode) {
  const stateName = stateCode === YT.PlayerState.PLAYING ? 'PLAYING'
    : stateCode === YT.PlayerState.PAUSED ? 'PAUSED'
    : stateCode === YT.PlayerState.ENDED ? 'ENDED'
    : stateCode === YT.PlayerState.BUFFERING ? 'BUFFERING'
    : stateCode === YT.PlayerState.CUED ? 'CUED'
    : 'UNSTARTED(-1)';

  if (ignoringEvents()) {
    updateNowPlaying();
    return;
  }

  if (Date.now() < settleUntil) {
    updateNowPlaying();
    return;
  }

  const name = stateCode === YT.PlayerState.PLAYING ? 'playing'
    : stateCode === YT.PlayerState.PAUSED ? 'paused'
    : stateCode === YT.PlayerState.ENDED ? 'ended'
    : null;

  // El admin es el unico que avanza la cola cuando un video termina.
  // Lo hace escribiendo directo a la DB (renderRoomState se encarga de
  // aplicar el cambio en TODOS los clientes, incluido este).
  if (name === 'ended' && isAdmin) {
    const idx = (room.current_queue_index || 0) + 1;
    const nextItem = queueCache[idx];
    const patch = nextItem
      ? {
          current_video_id: nextItem.video_id,
          current_queue_index: idx,
          playback_time: 0,
          player_state: 'playing',
          client_id: CLIENT_ID,
          updated_at: new Date().toISOString()
        }
      : {
          current_video_id: null,
          current_queue_index: 0,
          playback_time: 0,
          player_state: 'paused',
          client_id: CLIENT_ID,
          updated_at: new Date().toISOString()
        };
    settleUntil = Date.now() + SETTLE_WINDOW_MS;
    suppressPlayerEvents(SETTLE_WINDOW_MS);
    supabase.from('rooms').update(patch).eq('id', room.id);
    updateNowPlaying();
    return;
  }

  if (name === 'playing' || name === 'paused') {
    if (name === 'paused') {
      settleUntil = Date.now() + SETTLE_WINDOW_MS;
    }
    emitRoomState(name);
  }

  if (stateCode === YT.PlayerState.PLAYING && room) {
    if (!stateTimer) {
      stateTimer = setInterval(function () {
        if (!Player.isReady()) return;
        if (Player.getState() === YT.PlayerState.PLAYING) {
          const currentT = Player.getCurrentTime();
          if (Math.abs(currentT - lastSentPlaybackTime) > 2) {
            emitRoomState('playing');
          }
        }
      }, 4000);
    }
  } else if (stateCode === YT.PlayerState.PAUSED || stateCode === YT.PlayerState.ENDED) {
    clearInterval(stateTimer);
    stateTimer = null;
  }

  updateNowPlaying();
}

function setupRealtime() {
  const channel = supabase.channel('room:' + room.id);

  channel
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'id=eq.' + room.id },
      function (payload) {
        renderRoomState(payload.new);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'participants', filter: 'room_id=eq.' + room.id },
      function () {
        loadRoom().then(loadParticipants);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'queue', filter: 'room_id=eq.' + room.id },
      function () {
        loadQueue().then(function () {
          renderRoomState(room);
        });
      }
    )
    .subscribe(function (status) {
      if (status === 'SUBSCRIBED') {
        setStatus('Conectado a tiempo real.');
      }
    });
}

async function setupPlayer() {
  Player.init({
    containerId: 'player-container',
    onReady: function () {
      setStatus('Reproductor listo.');
      if (room && room.current_video_id) {
        renderRoomState(room);
      }
      if (currentVolume != null && Player.isReady()) {
        Player.setVolume(currentVolume);
      }
      updatePermissionsUI();
      progressTimer = setInterval(updateProgress, 1000);
    },
    onStateChange: onPlayerStateChange,
    onError: function (err) {
      console.error('Error del reproductor:', err);
      if (err === 150) {
        setStatus('Este video no permite reproducción embebida.');
      } else if (err === 2) {
        setStatus('ID de video invalido.');
      } else {
        setStatus('Error del reproductor de YouTube.');
      }
    }
  });
}

async function previewUrl() {
  const url = els.urlInput.value.trim();
  const cls = classifyInput(url);

  if (!cls.kind) {
    previewKind = null;
    previewId = null;
    els.previewBox.classList.add('hidden');
    setStatus('Link invalido. Pega una playlist o un video de YouTube.');
    return;
  }

  previewKind = cls.kind;
  previewId = cls.id;

  if (cls.kind === 'playlist') {
    els.previewName.textContent = 'Playlist ' + cls.id;
  } else {
    els.previewName.textContent = 'Video ' + cls.id;
  }
  els.previewId.textContent = cls.id;
  els.previewThumb.style.backgroundImage = `url('${getPlaylistThumbnail(cls.id)}')`;
  els.previewBox.classList.remove('hidden');
  els.addToQueue.disabled = !canControl;
  setStatus('');
}

async function addPreviewToQueue() {
  if (!canControl || !previewKind || !previewId) return;

  if (previewKind === 'playlist') {
    await addPlaylistToQueue(previewId, 'Playlist ' + previewId);
  } else {
    await addSingleVideoToQueue(previewId);
  }

  previewKind = null;
  previewId = null;
  els.urlInput.value = '';
  els.previewBox.classList.add('hidden');
}

async function addPlaylistToQueue(playlistId, playlistName) {
  setStatus('Cargando playlist...');
  let items;
  try {
    items = await YTApi.getPlaylistItems(playlistId);
  } catch (err) {
    console.warn('Error cargando playlist:', err);
    setStatus('No se pudo cargar la playlist: ' + err.message);
    return;
  }
  if (!items || !items.length) {
    setStatus('La playlist esta vacia o no se pudo leer.');
    return;
  }

  setStatus('Agregando ' + items.length + ' videos a la cola...');
  const startPos = await getNextPosition();

  const rows = items.map(function (it, i) {
    return {
      room_id: room.id,
      video_id: it.videoId,
      title: it.title,
      thumbnail: it.thumbnail || '',
      channel: it.channel || null,
      duration: it.duration || null,
      source_playlist_id: playlistId,
      source_playlist_name: playlistName,
      position: startPos + i,
      created_by: userId
    };
  });

  const { error: insErr } = await supabase.from('queue').insert(rows);
  if (insErr) {
    console.warn('Error insertando en cola:', insErr.message);
    setStatus('No se pudo agregar la playlist a la cola.');
    return;
  }

  await loadQueue();

  if (!room.current_video_id) {
    await startQueueAt(startPos, rows[0]);
  } else {
    setStatus('Playlist agregada.');
  }
}

async function addSingleVideoToQueue(videoId) {
  let meta = null;
  try {
    meta = await YTApi.getVideo(videoId);
  } catch (err) {
    console.warn('Error cargando video:', err);
    setStatus('No se pudo cargar el video: ' + err.message);
    return;
  }
  if (!meta) {
    setStatus('Video no encontrado.');
    return;
  }

  const startPos = await getNextPosition();
  const row = {
    room_id: room.id,
    video_id: meta.videoId,
    title: meta.title,
    thumbnail: meta.thumbnail || '',
    channel: meta.channel || null,
    duration: meta.duration || null,
    source_playlist_id: null,
    source_playlist_name: null,
    position: startPos,
    created_by: userId
  };

  const { error: insErr } = await supabase.from('queue').insert(row);
  if (insErr) {
    console.warn('Error insertando en cola:', insErr.message);
    setStatus('No se pudo agregar el video.');
    return;
  }

  await loadQueue();

  if (!room.current_video_id) {
    await startQueueAt(startPos, row);
  } else {
    setStatus('Video agregado a la cola.');
  }
}

async function getNextPosition() {
  const { data, error } = await supabase.rpc('next_queue_position', { target_room: room.id });
  if (error) {
    console.warn('next_queue_position error:', error.message);
    return 1;
  }
  return data || 1;
}

// Arranca la cola con el primer item cuando la sala estaba vacia.
// FASE 1: solo escribe a Supabase. renderRoomState (Fase 3) se encarga
// de aplicar el cambio en TODOS los clientes via Realtime.
async function startQueueAt(position, firstRow) {
  const idx = queueCache.length;
  await supabase.from('rooms').update({
    current_video_id: firstRow.video_id,
    current_queue_index: idx,
    playback_time: 0,
    player_state: 'playing',
    client_id: CLIENT_ID,
    updated_at: new Date().toISOString()
  }).eq('id', room.id);
}

async function savePreviewToProfile() {
  if (previewKind !== 'playlist' || !previewId) return;
  const name = 'Playlist ' + previewId;
  const { error } = await supabase.from('playlists').insert({
    user_id: userId,
    name,
    playlist_id: previewId
  });
  if (error) {
    console.warn('Error guardando playlist:', error.message);
    setStatus('No se pudo guardar en el perfil.');
    return;
  }
  setStatus('Guardado en tu perfil.');
  loadUserPlaylists();
}

async function addSavedToQueue() {
  if (!canControl) return;
  const id = els.savedSelect.value;
  if (!id) return;
  const option = els.savedSelect.options[els.savedSelect.selectedIndex];
  const name = option.getAttribute('data-name') || ('Playlist ' + id);

  await addPlaylistToQueue(id, name);
  els.savedSelect.value = '';
}

function applyTheme() {
  if (themeIsDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  if (els.iconSun && els.iconMoon) {
    els.iconSun.classList.toggle('hidden', themeIsDark);
    els.iconMoon.classList.toggle('hidden', !themeIsDark);
  }
}

// Patch utilitario para emitir un cambio a rooms. Usado por todos los handlers
// (Fase 1). Solo escribe a Supabase; el resto lo hace renderRoomState.
function patchRoom(patch) {
  return supabase.from('rooms').update({
    client_id: CLIENT_ID,
    updated_at: new Date().toISOString(),
    ...patch
  }).eq('id', room.id);
}

function bindUI() {
  updatePermissionsUI();

  if (els.resumeOverlay) {
    const resume = function () {
      if (!Player.isReady()) return;
      Player.unMute && Player.unMute();
      Player.play();
      hideResume();
    };
    els.resumeOverlay.addEventListener('click', resume);
    els.resumeOverlay.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resume(); }
    });
  }

  if (els.themeToggle) {
    applyTheme();
    els.themeToggle.addEventListener('click', function () {
      themeIsDark = !themeIsDark;
      applyTheme();
    });
  }

  if (els.usernameInput) {
    els.usernameInput.value = getUsername();
    els.usernameInput.addEventListener('change', async function () {
      const name = els.usernameInput.value.trim() || 'Anonimo';
      localStorage.setItem('username', name);
      const { error } = await supabase.auth.updateUser({ data: { username: name } });
      if (error) console.warn(error);
      await supabase.from('participants').update({ username: name })
        .eq('room_id', room.id).eq('user_id', userId);
      loadParticipants();
    });
  }

  if (els.shareBtn) {
    els.shareBtn.addEventListener('click', function () {
      const url = location.origin + location.pathname + '?c=' + roomCode;
      navigator.clipboard.writeText(url).then(function () {
        setStatus('Link copiado al portapapeles.');
      }).catch(function () {
        setStatus(url);
      });
    });
  }

  // ============ FASE 1: HANDLERS DE CONTROL ============
  // Cada handler hace UNA sola cosa: escribir a Supabase. Sin Player.*,
  // sin tocar room, sin refrescar UI. renderRoomState (Fase 3) hace el resto.

  if (els.playBtn) {
    els.playBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      if (!Player.isReady() || !room.current_video_id) return;
      patchRoom({
        player_state: 'playing',
        playback_time: Player.getCurrentTime(),
        current_video_id: Player.getVideoId()
      });
    });
  }

  if (els.pauseBtn) {
    els.pauseBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      if (!Player.isReady() || !room.current_video_id) return;
      patchRoom({
        player_state: 'paused',
        playback_time: Player.getCurrentTime(),
        current_video_id: Player.getVideoId()
      });
    });
  }

  if (els.prevBtn) {
    els.prevBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      const idx = (room.current_queue_index || 0) - 1;
      const target = queueCache[idx];
      if (!target) return;
      patchRoom({
        current_video_id: target.video_id,
        current_queue_index: idx,
        playback_time: 0,
        player_state: 'playing'
      });
    });
  }

  if (els.nextBtn) {
    els.nextBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      const idx = (room.current_queue_index || 0) + 1;
      const target = queueCache[idx];
      if (!target) return;
      patchRoom({
        current_video_id: target.video_id,
        current_queue_index: idx,
        playback_time: 0,
        player_state: 'playing'
      });
    });
  }

  if (els.volume) {
    els.volume.value = Player.getVolume();
    els.volume.addEventListener('input', function () {
      const v = Number(els.volume.value);
      Player.setVolume(v);
      if (els.volumeValue) els.volumeValue.textContent = String(v);
      currentVolume = v;
    });
  }

  if (els.progress) {
    els.progress.addEventListener('input', function () {
      if (els.progressCurrent) els.progressCurrent.textContent = formatTime(els.progress.value);
    });
    els.progress.addEventListener('change', function () {
      if (!canControl || !hasQueue) return;
      const seconds = Number(els.progress.value);
      if (!Player.isReady() || !room.current_video_id) return;
      patchRoom({
        current_video_id: Player.getVideoId(),
        playback_time: seconds
      });
    });
  }

  if (els.syncBtn) {
    els.syncBtn.addEventListener('click', function () {
      Promise.all([loadRoom(), loadQueue()]).then(function () {
        renderRoomState(room);
      });
    });
  }

  if (els.modeToggle) {
    els.modeToggle.addEventListener('change', async function () {
      if (!isAdmin) return;
      const isOpen = els.modeToggle.checked;
      const { error } = await supabase.from('rooms')
        .update({ is_open: isOpen }).eq('id', room.id);
      if (error) console.warn('Error cambiando modo:', error.message);
    });
  }

  if (els.urlInput) {
    els.urlInput.addEventListener('input', previewUrl);
  }

  if (els.addToQueue) {
    els.addToQueue.addEventListener('click', addPreviewToQueue);
  }

  if (els.saveToProfile) {
    els.saveToProfile.addEventListener('click', savePreviewToProfile);
  }

  if (els.loadSavedBtn) {
    els.loadSavedBtn.addEventListener('click', addSavedToQueue);
  }

  if (els.savedSelect) {
    els.savedSelect.addEventListener('change', function () {
      if (els.loadSavedBtn) els.loadSavedBtn.disabled = !canControl || !els.savedSelect.value;
    });
  }
}

async function leaveRoom() {
  try {
    if (room) {
      await supabase.from('participants')
        .delete()
        .eq('room_id', room.id)
        .eq('user_id', userId);
    }
  } catch (e) {
    console.warn('Error saliendo de la sala:', e);
  }
}

async function init() {
  bindElements();
  ensureSupabase();

  roomCode = new URLSearchParams(location.search).get('c');
  if (!roomCode) {
    setStatus('Falta el codigo de sala.');
    return;
  }

  try {
    const username = localStorage.getItem('username') || 'Anonimo';
    await ensureAuth(username);
    if (els.usernameInput) els.usernameInput.value = getUsername();

    const roomId = await getRoomIdByCode(roomCode);
    await joinParticipant(roomId);
    await loadRoom();
    await loadParticipants();
    await loadQueue();
    await loadUserPlaylists();

    setupRealtime();
    await setupPlayer();
    bindUI();

    window.addEventListener('beforeunload', leaveRoom);
    window.addEventListener('pagehide', leaveRoom);
  } catch (err) {
    console.error(err);
    setStatus('Error cargando la sala: ' + err.message);
  }
}

init();
