// Dot compacto (PRD de Dot §8.2): una línea para hablar con el asistente.
// Página propia y estática, servida por el lado nativo en su propio origen
// (`dot-ask`), sin IPC de Tauri: no habla con el daemon. Lo escrito sale solo
// hacia el lado nativo (`POST /send` a este mismo origen), que lo pasa a la
// ventana principal; esta es la que lo envía al asistente. No se guarda nada.
'use strict';

(function () {
  const nonce = document.querySelector('meta[name="dot-ask"]').getAttribute('content');
  const form = document.getElementById('ask');
  const input = document.getElementById('text');
  const status = document.getElementById('status');
  const waiting = document.getElementById('waiting');
  let busy = false;

  function say(text, bad) {
    status.textContent = text;
    status.classList.toggle('bad', Boolean(bad));
  }

  function request(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'x-dot-ask': nonce, 'content-type': 'text/plain;charset=utf-8' },
      body: body,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  }

  async function send() {
    if (busy) return;
    const text = input.value;
    if (!text.trim()) {
      say('Type something for your assistant.', true);
      return;
    }
    busy = true;
    input.disabled = true;
    say('Sending…', false);
    let message = 'Could not hand the message to Stratum Dot.';
    try {
      const response = await request('POST', 'send', text);
      const answer = await response.json();
      if (answer && answer.ok) {
        input.value = '';
        return; // el lado nativo cierra esta ventana y abre la principal
      }
      if (answer && typeof answer.message === 'string') message = answer.message;
    } catch (_) {
      /* sin respuesta: el mensaje genérico */
    }
    say(message, true);
    busy = false;
    input.disabled = false;
    input.focus();
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    void send();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      input.value = '';
      request('POST', 'dismiss', '').catch(function () {});
    }
  });

  // Lo que espera a la persona: solo un número, para que sepa que hay algo.
  request('GET', 'status')
    .then(function (response) {
      return response.json();
    })
    .then(function (answer) {
      const n = answer && typeof answer.waiting === 'number' ? answer.waiting : 0;
      if (n > 0) {
        waiting.textContent = '◆ ' + n + ' waiting';
        waiting.hidden = false;
      }
    })
    .catch(function () {});

  input.focus();
})();
