import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm, text, toolCall } from '../../stratum-cli/scripts/tui/mock-llm.mjs';
import { cliSessions, e2eConfig, launch, send, waitForIdle, waitForReady } from './harness.mjs';

/**
 * El panel de memoria global: lo que el asistente recuerda de una conversación
 * a otra (`memory.decisions`, con el agente que fija el perfil de Desktop),
 * contra un `stratumd` real. El asistente guarda una decisión con
 * `store_decision`; el panel la enseña con su procedencia, la abre en su
 * conversación y la olvida tras confirmar en la página.
 */
const TITLE = 'Prefiere vuelos de mañana';

const script = ({ last, said }) => {
  if (last.role === 'tool') return text('Lo recordaré.', 30);
  if (said.includes('recuerda')) {
    return toolCall('store_decision', {
      title: TITLE,
      content: 'El usuario prefiere salir antes de las 10.',
      type: 'user_preference',
      tags: ['viajes'],
      importance: 'medium',
    });
  }
  return text('Vale.', 30);
};

describe('memoria global del asistente (E2E)', () => {
  let app;
  let mock;
  const s = () => app.session;
  const rows = () =>
    s().execute(`return [...document.querySelectorAll('.assistant-memory__item')].map((li) => li.getAttribute('data-decision'))`);

  async function openPanel() {
    if (await s().execute(`return !!document.querySelector('.assistant-memory')`)) return;
    await s().clickButton('Contexto y memoria', { contains: true });
    await s().waitForElement('.assistant-memory');
  }

  before(async () => {
    mock = await startMockLlm(script);
    const config = (baseUrl) => {
      const value = e2eConfig(baseUrl);
      value.provider.providers.e2e.model = 'mock-model';
      return value;
    };
    app = await launch({ mock, config });
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
    await mock?.close();
  });

  it('sin nada guardado lo dice, también sin elegir sesión', async () => {
    await openPanel();
    await s().waitForText('El asistente aún no recuerda nada.', { timeout: 30_000 });
  });

  it('lo que guarda el asistente aparece al terminar el turno, con su procedencia y su conversación', async () => {
    await send(s(), 'recuerda que prefiero volar por la mañana');
    await s().waitForText('Lo recordaré.', { timeout: 60_000 });
    await waitForIdle(s());
    await openPanel();
    await s().waitFor(async () => (await rows()).length === 1, { timeout: 30_000, message: 'la decisión en el panel' });
    await s().clickButton(TITLE);
    await s().waitForText('La guardó el asistente');
    const [session] = await cliSessions(app.home);
    assert.ok(await s().button(`Abrir la conversación de ${TITLE}`), 'se puede abrir su conversación');
    assert.equal(session.agent, 'assistant');
  });

  it('buscar pide al daemon (que ordena por parecido) y vaciar el campo vuelve a las últimas', async () => {
    // La búsqueda del daemon ordena por parecido: lo que coincide sale, pero no filtra lo demás.
    await s().type(await s().find('.assistant-memory__search input'), 'vuelos');
    await s().clickButton('Buscar');
    await s().waitFor(async () => (await rows()).length === 1, { timeout: 30_000, message: 'la coincidencia' });
    await s().execute(`document.querySelector('.assistant-memory__search input').select()`);
    await s().type(await s().find('.assistant-memory__search input'), ''); // Retroceso
    await s().clickButton('Buscar');
    await s().waitFor(async () => (await rows()).length === 1, { timeout: 30_000, message: 'de vuelta la lista' });
  });

  it('olvidar pide confirmación en la página; después el daemon ya no la tiene', async () => {
    await s().clickButton(`Olvidar ${TITLE}`);
    await s().waitForText('¿Olvidar «');
    await s().clickButton('Olvidar');
    await s().waitForText('El asistente aún no recuerda nada.', { timeout: 30_000 });
    assert.deepEqual(await rows(), []);
  });
});
