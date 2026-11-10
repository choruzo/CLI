// Ventana de confirmación de Stratum Desktop. Página propia y estática, servida
// por el lado nativo en su propio origen (`desktop-confirm`), sin IPC de Tauri.
// Lo que enseña lo pide al lado nativo (que lo leyó del daemon) y lo pinta con
// `textContent`: nada de lo que escribe un modelo se interpreta como HTML.
//
// Confirmar exige: la ventana con el foco durante un momento (un clic que iba
// a otra ventana no aprueba), la frase exacta si la solicitud la pide, y un
// clic en el botón (Enter no confirma). Esc o Cancelar cancelan.
//
// La vista la arma `dot_link::ConfirmGate`, compartido con Stratum Dot, en
// inglés: aquí se traducen los textos que se conocen; uno nuevo se enseña tal cual.
'use strict';

(function () {
  const nonce = document.querySelector('meta[name="desktop-confirm"]').getAttribute('content');
  const $ = function (id) {
    return document.getElementById(id);
  };
  const ok = $('ok');
  const cancel = $('cancel');
  const phrase = $('phrase');
  const status = $('status');
  let view = null;
  let armed = false;
  let armTimer = null;
  let busy = false;

  const ACTIONS = {
    Approve: 'Aprobar',
    'Allow for this session': 'Permitir en esta sesión',
    'Allow for 10 minutes': 'Permitir 10 minutos',
    'Allow for 30 minutes': 'Permitir 30 minutos',
    'Allow for 60 minutes': 'Permitir 60 minutos',
    'Send answers': 'Enviar respuestas',
    'Approve plan': 'Aprobar el plan',
    'Revert files': 'Deshacer los cambios',
  };

  const TEXTS = {
    'This approves this request and the later ones of this session only. It does not change any configuration, and requests required by policy keep asking.':
      'Aprueba esta solicitud y las siguientes de esta sesión, y solo de esta. No cambia ninguna configuración, y lo que exige una política sigue preguntándose.',
    'Required by an environment policy: approve one at a time.':
      'Lo exige la política de un entorno: se aprueba de una en una.',
    'Not confirmed. Nothing was sent.': 'Sin confirmar. No se ha enviado nada.',
    'The confirmation expired. Nothing was sent.': 'La confirmación caducó. No se ha enviado nada.',
    'Approval authority was locked before you confirmed. Nothing was sent.':
      'Las aprobaciones se bloquearon antes de confirmar. No se ha enviado nada.',
    'The Stratum daemon changed before you confirmed. Nothing was sent.':
      'El daemon de Stratum cambió antes de confirmar. No se ha enviado nada.',
    'The connection with the Stratum daemon was lost before you confirmed. Nothing was sent.':
      'Se perdió la conexión con el daemon de Stratum antes de confirmar. No se ha enviado nada.',
    'The request was resolved elsewhere before you confirmed. Nothing was sent.':
      'La solicitud se resolvió en otro sitio antes de confirmar. No se ha enviado nada.',
    'The session ended before you confirmed. Nothing was sent.':
      'La sesión terminó antes de confirmar. No se ha enviado nada.',
    'Stratum Dot is closing. Nothing was sent.': 'Stratum Desktop se está cerrando. No se ha enviado nada.',
    'This confirmation is no longer open.': 'Esta confirmación ya no está abierta.',
    'Already confirming…': 'Ya se está confirmando…',
    'Read the request before confirming.': 'Lee la solicitud antes de confirmar.',
    'The phrase does not match. Nothing was approved.': 'La frase no coincide. No se ha aprobado nada.',
    'This request is no longer pending for this session. Nothing was sent.':
      'Esta solicitud ya no está pendiente en esta sesión. No se ha enviado nada.',
    'Approval authority is locked. Unlock it to resolve requests from Dot.':
      'Las aprobaciones están bloqueadas. Desbloquéalas para resolver desde Desktop.',
    // Deshacer turnos (modo código).
    'This puts the listed files back as they were before those turns: it restores some and deletes the ones those turns created. Nothing else in the project changes.':
      'Deja los ficheros de la lista como estaban antes de esos turnos: restaura unos y borra los que crearon esos turnos. Nada más del proyecto cambia.',
    'It does not undo SSH commands, other directories or processes.':
      'No deshace órdenes por SSH, otros directorios ni procesos.',
    'Some files have no copy (too large): they stay as they are.':
      'Algunos ficheros no tienen copia (son demasiado grandes): se quedan como están.',
    'The daemon cut the lists: more files are affected than shown.':
      'El daemon recortó las listas: hay más ficheros afectados de los que se ven.',
    'The session changed before you confirmed. Nothing was changed.':
      'La sesión cambió antes de confirmar. No se ha cambiado nada.',
  };

  const GRANT_NOTE =
    /^This approves this request and, for the next (\d+) minutes, every later call of (.+) in this session, without asking\. You can revoke it before then\. Requests required by policy keep asking\.$/;

  function tr(text) {
    if (typeof text !== 'string') return text;
    if (Object.prototype.hasOwnProperty.call(TEXTS, text)) return TEXTS[text];
    const grant = GRANT_NOTE.exec(text);
    if (grant) {
      return (
        'Aprueba esta solicitud y, durante ' +
        grant[1] +
        ' minutos, cada llamada siguiente de ' +
        grant[2] +
        ' en esta sesión, sin preguntar. Lo que exige una política sigue preguntándose.'
      );
    }
    return text;
  }

  function say(text, bad) {
    status.textContent = text;
    status.classList.toggle('bad', Boolean(bad));
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'x-desktop-confirm': nonce, 'content-type': 'text/plain;charset=utf-8' },
      body: body,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  }

  function fact(list, term, value, mono) {
    if (value === null || value === undefined || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    if (mono) dd.className = 'mono';
    dd.textContent = String(value);
    list.appendChild(dt);
    list.appendChild(dd);
  }

  function refresh() {
    const needsPhrase = view && view.approval && view.approval.confirmPhrase;
    const phraseOk = !needsPhrase || phrase.value === view.approval.confirmPhrase;
    ok.disabled = busy || !view || !armed || !phraseOk;
  }

  function arm() {
    clearTimeout(armTimer);
    armed = false;
    refresh();
    if (!view || !document.hasFocus()) return;
    armTimer = setTimeout(function () {
      armed = true;
      refresh();
    }, Math.max(800, view.armMs || 0));
  }

  function render(v) {
    view = v;
    const action = ACTIONS[v.action] || v.action;
    $('title').textContent = action;
    const facts = $('facts');
    const session = v.session || {};
    fact(facts, 'Acción', action);
    if (v.approval) {
      fact(facts, 'Herramienta', v.approval.tool, true);
      const dt = document.createElement('dt');
      dt.textContent = 'Qué hace';
      const dd = document.createElement('dd');
      const pre = document.createElement('pre');
      pre.className = 'action';
      pre.textContent = v.approval.description;
      dd.appendChild(pre);
      facts.appendChild(dt);
      facts.appendChild(dd);
      fact(facts, 'Destino', v.approval.target, true);
      fact(facts, 'Entorno', v.approval.environment);
      fact(facts, 'Motivo', v.approval.reason);
    }
    if (v.settings) {
      // Un cambio de ajustes: lo arma el lado nativo, y de un secreto nunca lleva el valor.
      fact(facts, 'Ajuste', v.settings.label);
      fact(facts, 'Clave', v.settings.key, true);
      fact(facts, 'Valor actual', v.settings.old);
      fact(facts, 'Valor nuevo', v.settings.new);
      $('lead').textContent =
        'Stratum Desktop te pide confirmar este cambio de configuración aquí, fuera de su ventana principal. ' +
        'Se escribe en tu configuración global de Stratum.';
    }
    if (v.revert) {
      const turns = v.revert.turns === 1 ? 'el último turno' : 'los últimos ' + v.revert.turns + ' turnos';
      fact(facts, 'Deshacer', turns);
      $('lead').textContent =
        'Stratum Desktop te pide confirmar aquí, fuera de su ventana principal, que se deshagan estos cambios. ' +
        'La lista la ha calculado el daemon de Stratum.';
    }
    fact(facts, 'Sesión', session.title || session.agent || session.id);
    fact(facts, 'Carpeta', session.cwd, true);
    fact(facts, 'Agente', [session.agent, session.model].filter(Boolean).join(' · '));
    fact(facts, 'Anfitrión', session.host);
    fact(facts, 'Run', v.runId, true);

    if (v.answers && v.answers.length > 0) {
      const list = $('answer-list');
      v.answers.forEach(function (a) {
        fact(list, a.question, a.answer);
      });
      $('answers').hidden = false;
    }
    if (v.plan) {
      $('plan-summary').textContent = v.plan.summary;
      const steps = $('plan-steps');
      v.plan.steps.forEach(function (s) {
        const li = document.createElement('li');
        li.textContent = s;
        steps.appendChild(li);
      });
      if (v.plan.moreSteps > 0) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = '…y ' + v.plan.moreSteps + ' pasos más';
        steps.appendChild(li);
      }
      $('plan').hidden = false;
    }
    if (v.revert) {
      renderRevert(v.revert);
      // Pisa y borra ficheros: se pinta como lo peligroso.
      document.body.classList.add('danger');
    }
    const notes = $('notes');
    (v.notes || []).forEach(function (n) {
      const li = document.createElement('li');
      li.textContent = tr(n);
      notes.appendChild(li);
    });
    if (v.approval && v.approval.confirmPhrase) {
      $('phrase-text').textContent = v.approval.confirmPhrase;
      $('phrase-box').hidden = false;
    }
    if (v.approval && (v.approval.forced || v.approval.confirmPhrase)) document.body.classList.add('danger');
    ok.textContent = action;
    $('expiry').textContent =
      'Esta confirmación caduca a las ' +
      new Date(v.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      '. No se envía nada hasta que pulses el botón.';
    arm();
  }

  // Las listas de un deshacer turnos, cada una recortada por el lado nativo ("y N más").
  function renderRevert(r) {
    const groups = [
      ['Se restauran', r.restore, r.moreRestore],
      ['Se borran', r.remove, r.moreRemove],
      ['Cambiados después (conflictos)', r.conflicts, r.moreConflicts],
      ['Sin copia: se quedan como están', r.skipped, r.moreSkipped],
    ];
    const anchor = $('notes');
    groups.forEach(function (g) {
      const paths = g[1] || [];
      const more = g[2] || 0;
      if (paths.length === 0 && more === 0) return;
      const section = document.createElement('section');
      section.className = 'block';
      const h2 = document.createElement('h2');
      h2.textContent = g[0];
      section.appendChild(h2);
      const list = document.createElement('ul');
      paths.forEach(function (p) {
        const li = document.createElement('li');
        li.className = 'mono';
        li.textContent = p;
        list.appendChild(li);
      });
      if (more > 0) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = '…y ' + more + ' más';
        list.appendChild(li);
      }
      section.appendChild(list);
      anchor.parentNode.insertBefore(section, anchor);
    });
  }

  async function load() {
    try {
      const response = await post('view', '');
      if (!response.ok) throw new Error('gone');
      render(await response.json());
    } catch (_) {
      say('Esta confirmación ya no está abierta.', true);
    }
  }

  ok.addEventListener('click', async function () {
    if (ok.disabled || busy) return;
    busy = true;
    refresh();
    say(view && view.settings ? 'Comprobando…' : 'Comprobando con el daemon de Stratum…', false);
    let message = 'No se pudo confirmar.';
    let keepOpen = false;
    try {
      const response = await post('confirm', phrase.value);
      const answer = await response.json();
      if (answer && answer.ok) {
        say(view && view.settings ? 'Confirmado. Escribiendo…' : 'Confirmado. Enviando…', false);
        return; // el lado nativo cierra la ventana
      }
      if (answer && typeof answer.message === 'string') message = tr(answer.message);
      keepOpen = Boolean(answer && answer.keepOpen);
    } catch (_) {
      /* sin respuesta: el mensaje genérico */
    }
    say(message, true);
    busy = false;
    if (keepOpen) {
      arm();
      if (!$('phrase-box').hidden) phrase.focus();
    } else {
      ok.disabled = true;
    }
  });

  function close() {
    post('cancel', '').catch(function () {});
  }

  cancel.addEventListener('click', close);
  phrase.addEventListener('input', refresh);
  phrase.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') event.preventDefault();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });
  // Sin el foco no se puede confirmar; al volver, otra espera.
  window.addEventListener('focus', arm);
  window.addEventListener('blur', arm);
  document.getElementById('confirm').addEventListener('submit', function (event) {
    event.preventDefault();
  });
  cancel.focus();
  load();
})();
