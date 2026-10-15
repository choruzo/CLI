// Ventana de confirmación de Stratum Dot. Página propia y estática, servida por
// el lado nativo en su propio origen (`dot-confirm`), sin IPC de Tauri. Lo que
// enseña lo pide al lado nativo (que lo leyó del daemon) y lo pinta con
// `textContent`: nada de lo que escribe un modelo se interpreta como HTML.
//
// Confirmar exige: la ventana con el foco durante un momento (un clic que iba
// a otra ventana no aprueba), la frase exacta si la solicitud la pide, y un
// clic en el botón (Enter no confirma). Esc o Cancel cancelan.
'use strict';

(function () {
  const nonce = document.querySelector('meta[name="dot-confirm"]').getAttribute('content');
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

  function say(text, bad) {
    status.textContent = text;
    status.classList.toggle('bad', Boolean(bad));
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'x-dot-confirm': nonce, 'content-type': 'text/plain;charset=utf-8' },
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
    $('title').textContent = v.action;
    const facts = $('facts');
    const session = v.session || {};
    fact(facts, 'Action', v.action);
    if (v.approval) {
      fact(facts, 'Tool', v.approval.tool, true);
      const dt = document.createElement('dt');
      dt.textContent = 'What it does';
      const dd = document.createElement('dd');
      const pre = document.createElement('pre');
      pre.className = 'action';
      pre.textContent = v.approval.description;
      dd.appendChild(pre);
      facts.appendChild(dt);
      facts.appendChild(dd);
      fact(facts, 'Target', v.approval.target, true);
      fact(facts, 'Environment', v.approval.environment);
      fact(facts, 'Reason', v.approval.reason);
    }
    fact(facts, 'Session', session.title || session.agent || session.id);
    fact(facts, 'Directory', session.cwd, true);
    fact(facts, 'Agent', [session.agent, session.model].filter(Boolean).join(' · '));
    fact(facts, 'Host', session.host);
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
        li.textContent = '…and ' + v.plan.moreSteps + ' more steps';
        steps.appendChild(li);
      }
      $('plan').hidden = false;
    }
    const notes = $('notes');
    (v.notes || []).forEach(function (n) {
      const li = document.createElement('li');
      li.textContent = n;
      notes.appendChild(li);
    });
    if (v.approval && v.approval.confirmPhrase) {
      $('phrase-text').textContent = v.approval.confirmPhrase;
      $('phrase-box').hidden = false;
    }
    if (v.approval && (v.approval.forced || v.approval.confirmPhrase)) document.body.classList.add('danger');
    ok.textContent = v.action;
    $('expiry').textContent =
      'This confirmation expires at ' +
      new Date(v.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      '. Nothing is sent until you press the button.';
    arm();
  }

  async function load() {
    try {
      const response = await post('view', '');
      if (!response.ok) throw new Error('gone');
      render(await response.json());
    } catch (_) {
      say('This confirmation is no longer open.', true);
    }
  }

  ok.addEventListener('click', async function () {
    if (ok.disabled || busy) return;
    busy = true;
    refresh();
    say('Checking with the Stratum daemon…', false);
    let message = 'Could not confirm.';
    let keepOpen = false;
    try {
      const response = await post('confirm', phrase.value);
      const answer = await response.json();
      if (answer && answer.ok) {
        say('Confirmed. Sending…', false);
        return; // el lado nativo cierra la ventana
      }
      if (answer && typeof answer.message === 'string') message = answer.message;
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
