let supabase = null;
const Player = window.Player;
let userId = null;
let user = null;
let roomCode = '';
let room = null;
let isAdmin = false;
let canControl = false;
let hasQueue = false;
let lastSentUpdatedAt = null;
let lastVideoId = null;

// Identificador unico de este cliente/pestana. Se incluye en cada emit para
// que el receptor pueda distinguir eco propio (mismo clientId) de un evento
// genuino de otro participante (distinto clientId), sin importar el tiempo.
// Se persiste en sessionStorage para que sobreviva a re-inicializaciones
// del modulo (reconexion de Realtime, etc.) durante la vida de la pestaña.
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
let lastAppliedAt = 0;            // timestamp (ms) del ultimo estado que el player local aplico (REMOTO o ACCION DE USUARIO). NO se actualiza por heartbeats.
let lastEmittedAt = 0;            // timestamp (ms) del ultimo estado que mande a DB (incluye heartbeats)
let lastSentPlaybackTime = 0;     // ultimo playback_time que mande a DB
let lastSentClientId = null;      // ultimo client_id que mande a DB (para deteccion de eco)
let applyingRemote = false;       // true mientras aplicamos un sync remoto (evita eco)
let settleUntil = 0;              // ventana de asentamiento: durante este tiempo suprimimos emisiones
let settleTimer = null;           // timer que ejecuta el check post-asentamiento
const REMOTE_STATE_GRACE_MS = 100;        // tolerancia para syncs que llegan casi al mismo tiempo
const SETTLE_WINDOW_MS = 600;             // ventana donde ignoramos transiciones intermedias del player

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

  // ID puro (11 chars tipicamente, validos en YouTube)
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

  // youtu.be/<id>
  const yMatch = input.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (yMatch) return yMatch[1];

  // youtube.com/watch?v=<id>
  const vMatch = input.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (vMatch) return vMatch[1];

  // youtube.com/shorts/<id>
  const sMatch = input.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (sMatch) return sMatch[1];

  // youtube.com/embed/<id>
  const eMatch = input.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (eMatch) return eMatch[1];

  console.warn('[extractVideoId] no se pudo extraer ID de:', input);
  return null;
}

// Detecta que tipo de input es. Retorna { kind: 'playlist' | 'video' | null, id }
function classifyInput(input) {
  if (!input) return { kind: null, id: null };
  const pid = extractPlaylistId(input);
  if (pid) return { kind: 'playlist', id: pid };
  const vid = extractVideoId(input);
  if (vid) return { kind: 'video', id: vid };
  return { kind: null, id: null };
}

function getPlaylistThumbnail(playlistId) {
  // No tenemos API key para thumbnails reales de playlists.
  // Devolvemos un SVG inline como placeholder (data URL) para evitar 404.
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

async function emitRoomState(playerState, extra) {
  if (!room || !Player.isReady()) return;

  extra = extra || {};
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const callerStack = (new Error()).stack.split('\n').slice(2, 4).join(' | ');
  const finalState = playerState || Player.getStateName();
  const finalTime = Player.getCurrentTime();
  // `isUserAction` indica que esto es una ACCION DIRECTA del usuario (boton play/pause/seek).
  // Solo en ese caso actualizamos lastAppliedAt. Los heartbeats periodicos (stateTimer) y los
  // emits automaticos NO son acciones del usuario, solo emiten para informar estado.
  const isUserAction = extra && extra.__userAction === true;
  if (isUserAction) delete extra.__userAction;

  console.log('[SYNC][EMIT]', {
    when: nowIso,
    ms: nowMs,
    caller: callerStack,
    state: finalState,
    clientId: CLIENT_ID,
    videoId: Player.getVideoId(),
    playbackTime: finalTime,
    isUserAction: isUserAction,
    extra: extra
  });

  const patch = {
    playback_time: finalTime,
    player_state: finalState,
    current_video_id: Player.getVideoId(),
    client_id: CLIENT_ID,
    updated_at: nowIso,
    ...extra
  };

  lastSentUpdatedAt = patch.updated_at;
  lastSentClientId = CLIENT_ID;
  lastSentPlaybackTime = patch.playback_time;
  lastEmittedAt = nowMs;
  if (isUserAction) {
    lastAppliedAt = nowMs;
  }

  const { error } = await supabase.from('rooms').update(patch).eq('id', room.id);
  if (error) {
    if (!canControl) {
      setStatus('No tenes permiso para controlar esta sala.');
    } else {
      console.warn('Error enviando estado:', error.message);
    }
  }
}

async function loadActiveItem() {
  if (!room.current_video_id) return;
  if (lastVideoId === room.current_video_id) return;
  lastVideoId = room.current_video_id;

  // Si la sala esta "playing", usamos loadVideo (que autoreproduce).
  // Si esta "paused", usamos cueVideo (no autoreproduce, evita el bug
  // del navegador de sonar solo al cargar).
  if (room.player_state === 'playing') {
    Player.loadVideo(room.current_video_id, room.playback_time || 0);
    // Reintento explicito por si el navegador bloqueo el autoplay.
    setTimeout(function () {
      if (Player.isReady() && Player.getState() !== YT.PlayerState.PLAYING) {
        Player.play();
        showResumeIfBlocked();
      }
    }, 600);
  } else {
    Player.cueVideo(room.current_video_id, room.playback_time || 0);
  }

  updateNowPlaying();
  updateProgress();
}

async function advanceQueue() {
  const idx = (room.current_queue_index || 0) + 1;
  const nextItem = queueCache[idx];

  if (!nextItem) {
    Player.stop();
    await supabase.from('rooms').update({
      current_video_id: null,
      current_queue_index: 0,
      playback_time: 0,
      player_state: 'paused',
      updated_at: new Date().toISOString()
    }).eq('id', room.id);
    return;
  }

  await supabase.from('rooms').update({
    current_video_id: nextItem.video_id,
    current_queue_index: idx,
    playback_time: 0,
    player_state: 'playing',
    updated_at: new Date().toISOString()
  }).eq('id', room.id);

  Player.loadVideo(nextItem.video_id, 0);
  Player.play();
}

function applyRemoteState(newRoom) {
  if (!room) return;
  if (!Player.isReady()) {
    // Sin player listo, solo sincronizamos metadata local sin actuar sobre el reproductor.
    console.log('[SYNC][RECV][no-player]', {
      state: newRoom.player_state,
      updated_at: newRoom.updated_at,
      lastAppliedAt: lastAppliedAt
    });
    syncRoomMetadata(newRoom);
    return;
  }

  const remoteMs = newRoom.updated_at ? new Date(newRoom.updated_at).getTime() : 0;

  // Eco: solo si el client_id del remitente coincide con el mio.
  // Ya no usamos cercania de tiempo como criterio principal: si el otro
  // participante actua casi al mismo tiempo, su evento es genuino y no debe
  // descartarse solo por proximidad temporal.
  const isEcho = newRoom.client_id && newRoom.client_id === CLIENT_ID;
  if (isEcho) {
    console.log('[SYNC][RECV][DROP-ECHO]', {
      remoteState: newRoom.player_state,
      remoteUpdatedAt: newRoom.updated_at,
      remoteMs: remoteMs,
      remoteClientId: newRoom.client_id,
      lastAppliedAt: lastAppliedAt,
      reason: 'same client_id'
    });
    return;
  }

  // Evento viejo: ya aplicamos algo mas reciente localmente (propio o remoto).
  // Comparamos contra lastAppliedAt (en ms). Tolerancia chica para no descartar
  // eventos del mismo instante por drift de reloj.
  if (remoteMs && remoteMs + REMOTE_STATE_GRACE_MS < lastAppliedAt) {
    console.log('[SYNC][RECV][DROP-STALE]', {
      remoteState: newRoom.player_state,
      remoteUpdatedAt: newRoom.updated_at,
      remoteMs: remoteMs,
      lastAppliedAt: lastAppliedAt,
      lastEmittedAt: lastEmittedAt,
      diff: lastAppliedAt - remoteMs
    });
    return;
  }

  console.log('[SYNC][RECV][APPLY]', {
    remoteState: newRoom.player_state,
    remoteUpdatedAt: newRoom.updated_at,
    remoteMs: remoteMs,
    remoteClientId: newRoom.client_id,
    lastAppliedAt: lastAppliedAt,
    currentPlayerState: Player.getState(),
    applyingRemote: applyingRemote
  });

  applyingRemote = true;
  try {
    syncRoomMetadata(newRoom);
    lastAppliedAt = Math.max(lastAppliedAt, remoteMs || Date.now());

    suppressPlayerEvents(1200);

    if (newRoom.current_video_id) {
      loadActiveItem();
    } else {
      Player.stop();
      updateProgress();
      return;
    }

    const targetTime = currentTargetTime(newRoom);
    const currentVideo = Player.getVideoId();
    const remoteVideo = newRoom.current_video_id;

    if (remoteVideo && currentVideo && currentVideo !== remoteVideo) {
      Player.loadVideo(remoteVideo, targetTime);
    }

    const diff = Math.abs(Player.getCurrentTime() - targetTime);
    if (diff > 2) {
      Player.seekTo(targetTime, true);
    }

    const state = Player.getState();
    if (newRoom.player_state === 'playing' && state !== YT.PlayerState.PLAYING) {
      Player.play();
    } else if (newRoom.player_state === 'paused' && state === YT.PlayerState.PLAYING) {
      Player.pause();
    }
  } finally {
    // Mantenemos applyingRemote hasta que termine la ventana de asentamiento
    // para que los rebotes intermedios del IFrame Player (BUFFERING/PLAYING/PAUSED)
    // NO generen eco.
    settleUntil = Date.now() + SETTLE_WINDOW_MS;
    scheduleSettleCheck();
  }

  updateNowPlaying();
  updateProgress();
}

// Despues de aplicar un estado remoto, esperamos a que el player se asiente.
// Si al final de la ventana el estado del player coincide con el aplicado, no emitimos.
// Si quedo en un estado distinto al que mandaron, emitimos ese estado "firme".
function scheduleSettleCheck() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(function () {
    settleTimer = null;
    applyingRemote = false;
    settleUntil = 0;

    if (!Player.isReady() || !room) return;

    const s = Player.getState();
    const playerStateName =
      s === YT.PlayerState.PLAYING ? 'playing' :
      s === YT.PlayerState.PAUSED ? 'paused' :
      s === YT.PlayerState.ENDED ? 'ended' :
      null;

    // La fuente de verdad es SIEMPRE room.player_state (lo que el remoto acaba de establecer).
    // El player local puede estar en transicion/buffering; lo que nunca debemos hacer es
    // pisar el estado remoto emitiendo un nuevo valor.
    const targetState = room.player_state;

    console.log('[SYNC][SETTLE]', {
      finalPlayerState: playerStateName,
      remoteState: targetState,
      match: playerStateName === targetState
    });

    // Si el player quedo en un estado distinto al que se aplico (porque estaba en buffering
    // o transicion), forzamos al player local a igualar el estado remoto. NUNCA emitimos
    // a la base de datos para "corregir" el remoto con el estado local.
    if (playerStateName && targetState && playerStateName !== targetState) {
      console.log('[SYNC][SETTLE][FORCE-LOCAL]', {
        playerState: playerStateName,
        targetState: targetState,
        action: targetState === 'playing' ? 'Player.play()' : 'Player.pause()'
      });
      if (targetState === 'playing' && s !== YT.PlayerState.PLAYING) {
        Player.play();
      } else if (targetState === 'paused' && s !== YT.PlayerState.PAUSED) {
        Player.pause();
      }
    }
  }, SETTLE_WINDOW_MS);
}

// Aplica solo la metadata al objeto room local (sin tocar el reproductor).
function syncRoomMetadata(newRoom) {
  room.is_open = newRoom.is_open;
  room.admin_id = newRoom.admin_id || room.admin_id;
  room.current_video_id = newRoom.current_video_id;
  room.current_queue_index = newRoom.current_queue_index;
  room.playback_time = newRoom.playback_time;
  room.player_state = newRoom.player_state;

  isAdmin = room.admin_id === userId;
  updateHasQueue();
  updatePermissionsUI();
  updateNowPlaying();
  renderQueue();
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

  // Determinar estado real segun el player
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
      // -1 unstarted, 3 buffering, 5 cued: la sala dice playing pero
      // el player no empezo -> probablemente bloqueo de autoplay.
      stateLabel = (room.player_state === 'playing') ? 'Listo para reproducir' : 'En pausa';
    }
  } else {
    stateLabel = (room.player_state === 'playing') ? 'Cargando reproductor...' : 'En pausa';
  }

  statusEl.textContent = stateLabel;
  statusEl.classList.remove('hidden');

  // Mostrar overlay si la sala deberia estar sonando pero no suena
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

  console.log('[SYNC][ONSTATE]', {
    state: stateName,
    stateCode: stateCode,
    ignoringEvents: ignoringEvents(),
    applyingRemote: applyingRemote,
    settleUntil: settleUntil,
    nowMs: Date.now(),
    inSettleWindow: Date.now() < settleUntil
  });

  if (ignoringEvents()) return;

  const name = stateCode === YT.PlayerState.PLAYING ? 'playing'
    : stateCode === YT.PlayerState.PAUSED ? 'paused'
    : stateCode === YT.PlayerState.ENDED ? 'ended'
    : null;

  // Si estamos aplicando un sync remoto O dentro de la ventana de asentamiento,
  // suprimimos TODAS las emisiones. El IFrame Player rebota BUFFERING/PLAYING/PAUSED
  // al pausar/seekear; cualquier emision durante esa secuencia genera eco.
  if (applyingRemote || Date.now() < settleUntil) {
    console.log('[SYNC][ONSTATE][SUPPRESS]', {
      reason: applyingRemote ? 'applyingRemote' : 'settleWindow',
      state: stateName
    });
    if (name === 'ended' && canControl && !applyingRemote) {
      advanceQueue();
    }
    updateNowPlaying();
    return;
  }

  if (name === 'playing' || name === 'paused') {
    if (name === 'paused') {
      // Abrimos ventana corta para que cualquier rebote BUFFERING/PLAYING
      // post-pause no reemita.
      settleUntil = Date.now() + SETTLE_WINDOW_MS;
    }
    console.log('[SYNC][ONSTATE][EMIT-VIA]', { state: stateName });
    // Si llegamos aca (no suprimido por settle/applyingRemote/ignoreEvents),
    // el cambio es legitimo del usuario. Marcamos como userAction para que
    // lastAppliedAt se actualice.
    emitRoomState(name, { __userAction: true });
  }

  if (name === 'ended' && canControl) {
    // Video terminado: avanzar al siguiente item de la cola.
    advanceQueue();
  }

  if (!canControl) return;

  if (stateCode === YT.PlayerState.PLAYING && room) {
    if (!stateTimer) {
      stateTimer = setInterval(function () {
        if (!Player.isReady()) return;
        if (Player.getState() === YT.PlayerState.PLAYING) {
          const currentT = Player.getCurrentTime();
          const drift = Math.abs(currentT - lastSentPlaybackTime);
          console.log('[SYNC][STATE-TIMER]', {
            drift: drift,
            willEmit: drift > 2,
            currentT: currentT,
            lastSentPlaybackTime: lastSentPlaybackTime
          });
          if (drift > 2) {
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
        applyRemoteState(payload.new);
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
          updateNowPlaying();
          updatePermissionsUI();
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
        loadActiveItem();
      }
      // Aplicar volumen inicial
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

  // Si no hay nada sonando, arrancar con el primer video de la playlist.
  if (!room.current_video_id) {
    await startQueueAt(startPos, rows[0]);
  } else {
    setStatus('Playlist agregada.');
  }

  await loadQueue();
  updateHasQueue();
  updateNowPlaying();
  updatePermissionsUI();
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

  if (!room.current_video_id) {
    await startQueueAt(startPos, row);
  } else {
    setStatus('Video agregado a la cola.');
  }

  await loadQueue();
  updateHasQueue();
  updateNowPlaying();
  updatePermissionsUI();
}

async function getNextPosition() {
  const { data, error } = await supabase.rpc('next_queue_position', { target_room: room.id });
  if (error) {
    console.warn('next_queue_position error:', error.message);
    return 1;
  }
  return data || 1;
}

async function startQueueAt(position, firstRow) {
  const idx = queueCache.length; // sera el primer item nuevo
  const { data: updatedRoom, error: roomErr } = await supabase.from('rooms').update({
    current_video_id: firstRow.video_id,
    current_queue_index: idx,
    playback_time: 0,
    player_state: 'playing',
    updated_at: new Date().toISOString()
  }).eq('id', room.id).select().single();

  if (roomErr) console.warn('Error actualizando sala:', roomErr.message);
  if (updatedRoom) Object.assign(room, updatedRoom);

  Player.loadVideo(firstRow.video_id, 0);
  Player.play();
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

function bindUI() {
  updatePermissionsUI();

  if (els.resumeOverlay) {
    const resume = function () {
      if (!Player.isReady()) return;
      Player.unMute && Player.unMute();
      Player.play();
      hideResume();
      // Si el play fue bloqueado por el browser, YT va a tirar un error
      // que se refleja en onError; el overlay reaparece via showResumeIfBlocked.
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

  if (els.playBtn) {
    els.playBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      emitRoomState('playing', { __userAction: true });
      Player.play();
    });
  }

  if (els.pauseBtn) {
    els.pauseBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      emitRoomState('paused', { __userAction: true });
      Player.pause();
    });
  }

  if (els.prevBtn) {
    els.prevBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      const idx = (room.current_queue_index || 0) - 1;
      const target = queueCache[idx];
      if (!target) return;
      suppressPlayerEvents(1000);
      (async function () {
        await supabase.from('rooms').update({
          current_video_id: target.video_id,
          current_queue_index: idx,
          playback_time: 0,
          player_state: 'playing',
          updated_at: new Date().toISOString()
        }).eq('id', room.id);
      })();
      Player.loadVideo(target.video_id, 0);
      Player.play();
    });
  }

  if (els.nextBtn) {
    els.nextBtn.addEventListener('click', function () {
      if (!canControl || !hasQueue) return;
      const idx = (room.current_queue_index || 0) + 1;
      const target = queueCache[idx];
      if (!target) return;
      suppressPlayerEvents(1000);
      (async function () {
        await supabase.from('rooms').update({
          current_video_id: target.video_id,
          current_queue_index: idx,
          playback_time: 0,
          player_state: 'playing',
          updated_at: new Date().toISOString()
        }).eq('id', room.id);
      })();
      Player.loadVideo(target.video_id, 0);
      Player.play();
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
    let seeking = false;
    els.progress.addEventListener('input', function () {
      seeking = true;
      if (els.progressCurrent) els.progressCurrent.textContent = formatTime(els.progress.value);
    });
    els.progress.addEventListener('change', function () {
      seeking = false;
      if (!canControl || !hasQueue) return;
      const seconds = Number(els.progress.value);
      Player.seekTo(seconds, true);
      emitRoomState(Player.getStateName(), {
        current_video_id: Player.getVideoId(),
        playback_time: seconds,
        __userAction: true
      });
    });
  }

  if (els.syncBtn) {
    els.syncBtn.addEventListener('click', function () {
      Promise.all([loadRoom(), loadQueue()]).then(function () {
        applyRemoteState(room);
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
