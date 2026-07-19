import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://ynhqovtkloteoeiekqro.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_8t97Z2nL4xy3mUplbEiN-Q_UHSLcA5a';

function warn(message) {
  console.error(message);
}

let client = null;
let err = null;

if (!SUPABASE_URL.startsWith('https://') || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.length < 30) {
  err = new Error('Supabase no esta configurado. Reemplaza SUPABASE_URL y SUPABASE_ANON_KEY en js/supabase-client.js');
} else {
  try {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  } catch (e) {
    err = e;
    warn('No se pudo inicializar Supabase: ' + e.message);
  }
}

window.supabase = client;
window.supabaseInitError = err;
