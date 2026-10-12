import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

/**
 * Reglas de arquitectura del daemon, comprobadas sobre el código fuente:
 *
 *  1. `src/daemon/` no monta agentes por su cuenta: ni importa `StratumAgent` ni
 *     lo instancia. Una sesión solo nace de `SessionHost.create`.
 *  2. Cerrar una sesión no es cerrar el proceso: el cierre global
 *     (`closeExecRuntime`) solo lo toca el apagado del daemon.
 *  3. El servidor de pruebas del cliente no es la base del daemon.
 *  4. El canal es local: nada de TCP ni HTTP.
 */

const here = dirname(fileURLToPath(import.meta.url));

const sources = readdirSync(here)
  // Este fichero nombra lo que prohíbe: no se comprueba a sí mismo.
  .filter((f) => f.endsWith('.ts') && f !== 'architecture.test.ts')
  .map((f) => ({ file: f, text: readFileSync(join(here, f), 'utf-8') }));
const production = sources.filter(
  (s) => !s.file.endsWith('.test.ts') && !s.file.endsWith('.fixtures.ts'),
);

/** Especificadores de los `import`/`export … from` de un fichero. */
function imports(text: string): string[] {
  return [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

/** Código sin comentarios, para no confundir una explicación con un uso. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('arquitectura de src/daemon/', () => {
  it('hay código que comprobar', () => {
    expect(production.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'daemon.ts',
        'hosted-session.ts',
        'event-hub.ts',
        'control-server.ts',
      ]),
    );
  });

  it('ningún fichero importa ni instancia StratumAgent', () => {
    for (const { file, text } of sources) {
      for (const spec of imports(text)) {
        expect(spec.endsWith('agent/core.js'), `${file} importa ${spec}`).toBe(false);
      }
      expect(/new\s+StratumAgent\b/.test(text), `${file} instancia StratumAgent`).toBe(false);
      expect(/\bStratumAgent\b/.test(code(text)), `${file} usa StratumAgent`).toBe(false);
    }
  });

  it('las sesiones se montan solo con SessionHost.create, y solo en hosted-session.ts', () => {
    const creators = production.filter((s) => /SessionHost\.create\(/.test(code(s.text)));
    expect(creators.map((s) => s.file)).toEqual(['hosted-session.ts']);
    for (const { file, text } of production) {
      expect(/new\s+SessionHost\b/.test(code(text)), file).toBe(false);
      // Tampoco por piezas: registry, loop o dispatcher propios.
      for (const spec of imports(text)) {
        expect(/agent\/harness\.js$|tools\/index\.js$/.test(spec), `${file} importa ${spec}`).toBe(
          false,
        );
      }
    }
  });

  it('el cierre global del proceso solo aparece en el apagado del daemon', () => {
    const users = production.filter((s) =>
      /closeExecRuntime|shutdownAllJobs|closeSshPool/.test(s.text),
    );
    expect(users.map((s) => s.file)).toEqual(['daemon.ts']);

    const daemon = code(production.find((s) => s.file === 'daemon.ts')!.text);
    // Una sola llamada posible, y está dentro de `shutdown()`.
    expect(daemon.match(/processTeardown \?\? closeExecRuntime/g)).toHaveLength(1);
    const shutdown = daemon.slice(
      daemon.indexOf('  shutdown(reason'),
      daemon.indexOf('  async crash('),
    );
    expect(shutdown).toContain('processTeardown ?? closeExecRuntime');
    // El camino de `sessions.close` no lo menciona.
    const closeSession = daemon.slice(
      daemon.indexOf('  private closeSession('),
      daemon.indexOf('  private handlers('),
    );
    expect(closeSession).toContain('session.close(reason)');
    expect(closeSession).not.toMatch(/processTeardown|closeExecRuntime/);
    // Y la sesión, al cerrarse, desmonta su anfitrión y nada más.
    const hosted = code(production.find((s) => s.file === 'hosted-session.ts')!.text);
    expect(hosted).toContain('this.host.dispose(');
  });

  it('el servidor de pruebas del cliente no se usa aquí', () => {
    for (const { file, text } of sources) {
      for (const spec of imports(text)) {
        expect(spec.includes('testing/'), `${file} importa ${spec}`).toBe(false);
      }
    }
  });

  it('sin TCP ni HTTP: solo el módulo net sobre un pipe o un socket local', () => {
    for (const { file, text } of production) {
      for (const spec of imports(text)) {
        expect(
          ['http', 'https', 'http2', 'dgram', 'tls', 'ws'],
          `${file} importa ${spec}`,
        ).not.toContain(spec.replace(/^node:/, ''));
      }
      // Escuchar con un puerto sería TCP.
      expect(/\.listen\(\s*\d/.test(code(text)), file).toBe(false);
    }
    const server = code(production.find((s) => s.file === 'control-server.ts')!.text);
    expect(server).toContain('this.server.listen(this.opts.ipcPath');
  });

  it('el token no se escribe en ningún log', () => {
    for (const { file, text } of production) {
      for (const call of code(text).matchAll(
        /log\.(?:trace|debug|info|warn|error)\(([\s\S]*?)\);/g,
      )) {
        expect(/token|\benv\b|apiKey/i.test(call[1]!), `${file}: ${call[1]}`).toBe(false);
      }
    }
  });

  // --- M3: sesiones pares ---------------------------------------------------

  it('de una sesión par el daemon solo tiene la proyección: nada del runtime', () => {
    const peers = production.find((s) => s.file === 'peer-sessions.ts')!;
    for (const spec of imports(peers.text)) {
      expect(
        /\/(host|agent|tools|jobs|memory|trace|session|providers|config|runtime)\//.test(spec),
        `peer-sessions.ts importa ${spec}`,
      ).toBe(false);
    }
    expect(/SessionHost|SessionPublisher|\.dispose\(/.test(code(peers.text))).toBe(false);
  });

  it('el daemon no numera: ningún seq se calcula ni se asigna a un evento', () => {
    for (const { file, text } of production) {
      const source = code(text);
      expect(/\bseq\s*(\+\+|\+=)|\+\+\s*\w*[sS]eq\b/.test(source), file).toBe(false);
      // Ni se construyen eventos de estado propios (un literal con `type` y `seq`).
      expect(/type:\s*'session\.(detached|closed|updated|opened)'/.test(source), file).toBe(false);
    }
  });

  it('hay un único publicador de sesiones, y el puente par lo reutiliza sin ser dueño del runtime', () => {
    const src = join(here, '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );
    const publishers: string[] = [];
    for (const file of walk(src)) {
      for (const match of readFileSync(file, 'utf-8').matchAll(/class\s+(\w*Publisher)\b/g)) {
        publishers.push(`${relative(src, file).replace(/\\/g, '/')}:${match[1]}`);
      }
    }
    expect(publishers).toEqual(['host/session-publisher.ts:SessionPublisher']);

    const bridge = code(readFileSync(join(src, 'host', 'peer-host-bridge.ts'), 'utf-8'));
    expect(bridge).toContain('new SessionPublisher(');
    // Transporte: ni desmonta la sesión, ni numera, ni construye fotos.
    expect(/\.dispose\(/.test(bridge)).toBe(false);
    expect(/\bseq\s*(\+\+|\+=)|seq:\s*\w+\s*\+\s*1/.test(bridge)).toBe(false);
    expect(/SessionHost\b/.test(bridge)).toBe(false);
    // Y el entorno de la terminal no viaja: el puente no lo toca.
    expect(/process\.env|\benv\b\s*[:.]/.test(bridge)).toBe(false);
  });

  it('la ruta de este test es la esperada (src/daemon)', () => {
    expect(relative(join(here, '..', '..'), here).replace(/\\/g, '/')).toBe('src/daemon');
  });
});
