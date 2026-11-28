// Dot compacto (PRD de Dot §8.2): una línea para hablar con el asistente.
// Página propia y estática, servida por el lado nativo en su propio origen
// (`dot-ask`), sin IPC de Tauri: no habla con el daemon. Lo escrito sale solo
// hacia el lado nativo (`POST /send` a este mismo origen), que lo pasa a la
// ventana principal; esta es la que lo envía al asistente. No se guarda nada.
//
// M25 fase 4 (parte 3): el atajo, mantenido, graba una nota. La nota la graba el
// lado nativo y esta página solo pregunta cómo va (`GET /voice`, cada 150 ms
// mientras hay algo en curso) y enseña «Listening…», «Transcribing…» o el
// motivo. El audio no llega aquí: solo los segundos y el nivel. El texto sí, y
// se queda en el campo.
'use strict';

// La composición de la marca del principio, y sus casos:
//
//   mmss(7.4) = '0:07'          mmss(102) = '1:42'         mmss(0) = '0:00'
//   voiceMarker(7, false)  = '[nota de voz, 0:07] '
//   voiceMarker(102, true) = '[nota de voz, 1:42, recortada] '
//
//   campo vacío + «hola»          → '[nota de voz, 0:07] hola'
//   «recuérdame» + «la compra»    → '[nota de voz, 0:07] recuérdame la compra'
//   «recuérdame la compra» tocado → 'recuérdame la compra' (sin marca: lo que se
//                                   corrige ya es de la persona)
//
// Solo se pone si el campo **contiene tal cual** lo que dejó la nota, ni un
// carácter cambiado en esa parte.
function mmss(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function voiceMarker(seconds, capped) {
  return '[nota de voz, ' + mmss(seconds) + (capped ? ', recortada' : '') + '] ';
}

(function () {
  const nonce = document.querySelector('meta[name="dot-ask"]').getAttribute('content');
  const form = document.getElementById('ask');
  const input = document.getElementById('text');
  const status = document.getElementById('status');
  const waiting = document.getElementById('waiting');
  const voice = document.getElementById('voice');
  const voiceLabel = document.getElementById('voice-label');
  const voiceLevel = document.getElementById('voice-level');
  // Cada cuánto se pregunta por la nota. Es un `fetch` al propio origen (no hay
  // red ni daemon detrás), y se hace siempre que la ventana está abierta: la
  // ventana se reutiliza para la siguiente nota y, sin IPC, esta página no tiene
  // otra forma de enterarse de que ha empezado.
  const POLL_MS = 150;
  let busy = false;
  let pollTimer = null;
  let polling = false;
  let voiceState = 'idle';
  // Lo que último se atendió (`done`/`error`), para no repetirlo si el `ack` no
  // llegó: se vuelve a atender cuando el estado cambia de verdad.
  let handled = '';
  // Lo último que dejó una nota: el texto exacto que se puso y cómo fue, para
  // saber al enviar si sigue tal cual.
  let note = null;

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
    const written = input.value;
    if (!written.trim()) {
      say('Type something for your assistant.', true);
      return;
    }
    busy = true;
    input.disabled = true;
    say('Sending…', false);
    // La marca la pone la página: si el texto de la nota sigue tal cual, el
    // mensaje dice de dónde salió. El lado nativo envía lo que le llegue.
    const text =
      note && note.inserted && written.indexOf(note.inserted) !== -1
        ? voiceMarker(note.durationSec, note.capped) + written
        : written;
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

  // ------------------------------------------------------------- la voz

  function setVoiceState(state) {
    voiceState = state;
    voice.hidden = state === 'idle';
    document.body.dataset.voice = state;
  }

  function showListening(seconds, level) {
    setVoiceState('listening');
    voiceLabel.textContent = 'Listening… ' + mmss(seconds);
    // El nivel llega en dBFS (−100..0): la barra va de −60 a 0. `null` es
    // «todavía no ha llegado ninguna muestra».
    const dbfs = typeof level === 'number' ? level : -60;
    const filled = Math.max(0, Math.min(1, (dbfs + 60) / 60));
    voiceLevel.style.width = (filled * 100).toFixed(1) + '%';
    document.body.style.setProperty('--level', filled.toFixed(3));
  }

  function showTranscribing() {
    setVoiceState('transcribing');
    voiceLabel.textContent = 'Transcribing…';
    voiceLevel.style.width = '0%';
  }

  /** El texto, detrás de lo que ya hubiera y con el cursor al final. */
  function insertNote(answer) {
    const text = typeof answer.text === 'string' ? answer.text : '';
    const before = input.value;
    // Separado por un espacio de lo anterior (sin doblarlo si ya acababa en uno).
    const gap = before && !/\s$/.test(before) ? ' ' : '';
    input.value = before + gap + text;
    note = {
      inserted: text,
      durationSec: Number(answer.durationSec) || 0,
      capped: Boolean(answer.capped),
    };
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  /** La página ya leyó el texto (o el motivo): el nativo vuelve a `idle`. */
  function acknowledge() {
    request('POST', 'voice/ack', '').catch(function () {});
  }

  function apply(answer) {
    const state = answer && typeof answer.state === 'string' ? answer.state : 'idle';
    if (state === 'listening') {
      handled = '';
      showListening(answer.seconds, answer.level);
      return;
    }
    if (state === 'transcribing') {
      handled = '';
      showTranscribing();
      return;
    }
    setVoiceState('idle');
    if (state !== 'done' && state !== 'error') {
      handled = '';
      return;
    }
    // Ya atendido y el `ack` aún no había llegado: no se repite.
    const key = JSON.stringify(answer);
    if (key === handled) return;
    handled = key;
    if (state === 'done') {
      insertNote(answer);
    } else {
      say(
        typeof answer.message === 'string'
          ? answer.message
          : 'The note could not be transcribed.',
        true,
      );
    }
    acknowledge();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const response = await request('GET', 'voice');
      if (response.ok) apply(await response.json());
    } catch (_) {
      /* sin respuesta: se reintenta en la siguiente vuelta */
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(function () {
      void poll();
    }, POLL_MS);
  }

  /** `Esc` mientras se escucha: se tira la nota y la ventana se queda. */
  async function cancelNote() {
    setVoiceState('idle');
    try {
      await request('POST', 'voice/cancel', '');
    } catch (_) {
      /* el nativo la tira igual al cerrarse la ventana */
    }
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
    if (event.key !== 'Escape') return;
    if (voiceState === 'listening' || voiceState === 'transcribing') {
      // Primero se tira la nota; el siguiente `Esc` cierra el compacto.
      void cancelNote();
      return;
    }
    input.value = '';
    note = null;
    request('POST', 'dismiss', '').catch(function () {});
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

  // Al abrirse: puede que el atajo ya esté grabando (o transcribiendo), y la
  // ventana se reutiliza para la siguiente nota.
  void poll();
  startPolling();

  input.focus();
})();
