const supabase = window.supabase;
const form = {
  name: document.getElementById('username'),
  createBtn: document.getElementById('create-room'),
  joinBtn: document.getElementById('join-room'),
  codeInput: document.getElementById('join-code'),
  status: document.getElementById('status')
};

function setStatus(message) {
  if (form.status) form.status.textContent = message;
  console.log(message);
}

function ensureSupabase() {
  if (!supabase) {
    const initErr = window.supabaseInitError;
    setStatus(
      initErr ? 'Supabase no configurado: ' + initErr.message : 'Supabase no esta configurado. Revisa js/supabase-client.js'
    );
    return false;
  }
  return true;
}

async function ensureAuth(username) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (!session) {
    const { data, error: signErr } = await supabase.auth.signInAnonymously({
      options: { data: { username: username || 'Anonimo' } }
    });
    if (signErr) throw signErr;
    return data.user;
  }
  if (username && username !== session.user.user_metadata?.username) {
    await supabase.auth.updateUser({ data: { username } });
  }
  return session.user;
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function createRoom() {
  if (!ensureSupabase()) return;
  const username = form.name.value.trim() || 'Anonimo';
  localStorage.setItem('username', username);

  try {
    const user = await ensureAuth(username);
    const code = generateCode();
    const { data: room, error: roomErr } = await supabase
      .from('rooms')
      .insert({
        code,
        name: 'Sala de ' + username,
        admin_id: user.id,
        is_open: true,
        active: true
      })
      .select()
      .single();

    if (roomErr) {
      console.error(roomErr);
      setStatus('No se pudo crear la sala: ' + (roomErr.message || roomErr.code || 'error desconocido'));
      return;
    }

    const { error: partErr } = await supabase.from('participants').insert({
      room_id: room.id,
      user_id: user.id,
      username,
      is_admin: true
    });

    if (partErr) {
      console.error(partErr);
      setStatus('Sala creada pero no se pudo unir como admin.');
      return;
    }

    location.href = 'room.html?c=' + encodeURIComponent(code);
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
  }
}

async function joinRoom() {
  if (!ensureSupabase()) return;
  const code = form.codeInput.value.trim().toUpperCase();
  if (!code) {
    setStatus('Ingresa un codigo de sala.');
    return;
  }

  const username = form.name.value.trim() || 'Anonimo';
  localStorage.setItem('username', username);

  try {
    await ensureAuth(username);
    location.href = 'room.html?c=' + encodeURIComponent(code);
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
  }
}

if (form.createBtn) form.createBtn.addEventListener('click', createRoom);
if (form.joinBtn) form.joinBtn.addEventListener('click', joinRoom);
if (form.codeInput) {
  form.codeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') joinRoom();
  });
}
