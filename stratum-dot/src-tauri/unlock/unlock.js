// Ventana de desbloqueo de Stratum Dot. Página propia y estática, servida por
// el lado nativo en su propio origen (`dot-unlock`), sin IPC de Tauri y sin
// nada del modelo. La clave solo sale de aquí hacia el lado nativo (`POST
// /submit` a este mismo origen) y el campo se vacía al enviarla. No se guarda
// en ningún sitio: ni almacenamiento, ni cookies, ni la URL.
'use strict';

(function () {
  const nonce = document.querySelector('meta[name="dot-unlock"]').getAttribute('content');
  const form = document.getElementById('unlock');
  const input = document.getElementById('key');
  const status = document.getElementById('status');
  const submit = document.getElementById('submit');
  const cancel = document.getElementById('cancel');
  let busy = false;

  function say(text, bad) {
    status.textContent = text;
    status.classList.toggle('bad', Boolean(bad));
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'x-dot-unlock': nonce, 'content-type': 'text/plain;charset=utf-8' },
      body: body,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;
    const key = input.value;
    // Lo tecleado deja de estar en el campo en cuanto se envía.
    input.value = '';
    if (!key) {
      say('Type the approver key.', true);
      input.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    input.disabled = true;
    say('Checking with the Stratum daemon…', false);
    let message = 'Could not unlock approval authority.';
    try {
      const response = await post('submit', key);
      const answer = await response.json();
      if (answer && answer.ok) {
        say('Unlocked.', false);
        return; // el lado nativo cierra la ventana
      }
      if (answer && typeof answer.message === 'string') message = answer.message;
    } catch (_) {
      /* sin respuesta: el mensaje genérico */
    }
    say(message, true);
    // Sin bucles: un momento antes de poder probar otra vez.
    setTimeout(function () {
      busy = false;
      submit.disabled = false;
      input.disabled = false;
      input.focus();
    }, 2000);
  });

  function close() {
    input.value = '';
    post('cancel', '').catch(function () {});
  }

  cancel.addEventListener('click', close);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });
  input.focus();
})();
