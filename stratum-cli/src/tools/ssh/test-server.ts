import { generateKeyPairSync } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { statSync } from 'fs';
// `ssh2` es CJS: el detector de exports de Node reconoce `Client` pero no
// `Server` ni `utils`, así que estos se toman del default import.
import ssh2 from 'ssh2';
import type { Connection, ServerChannel } from 'ssh2';

const { Server, utils } = ssh2;
import { fingerprintOf } from './known-hosts.js';

/**
 * Servidor SSH en proceso para los tests (Hito 9). `ssh2` trae un `Server`
 * completo, así que los tests corren contra el protocolo real: nada de mocks
 * del handshake, la autenticación, exec o SFTP.
 */

export interface ExecRequest {
  command: string;
  stream: ServerChannel;
  /** Marca el comando como matado por señal (SIGKILL desde el cliente). */
  onSignal: (cb: (name: string) => void) => void;
}

export interface TestServerOptions {
  /** Manejador de `exec`. Por defecto, el intérprete de comandos de abajo. */
  onExec?: (req: ExecRequest) => void;
  /** Cuando se define, solo se acepta auth por password con este valor. */
  password?: string;
  /** Rechaza toda autenticación (para probar errores de conexión). */
  rejectAuth?: boolean;
  /** Habilita el subsistema SFTP (por defecto sí). */
  sftp?: boolean;
  /** Habilita `direct-tcpip` para probar jump hosts (por defecto no). */
  allowForward?: boolean;
}

export interface TestServer {
  port: number;
  /** Fingerprint SHA256 de la host key, en el mismo formato que known_hosts. */
  fingerprint: string;
  /** Nº de conexiones aceptadas: sirve para verificar la reutilización del pool. */
  connectionCount: () => number;
  close: () => Promise<void>;
}

/**
 * Intérprete de comandos por defecto. Cada test elige el comportamiento con el
 * propio texto del comando en vez de tener que pasar un handler.
 */
function defaultExec(req: ExecRequest): void {
  const { command, stream } = req;

  if (command.startsWith('fail ')) {
    const code = Number(command.slice(5)) || 1;
    stream.stderr.write(`error: código ${code}\n`);
    stream.exit(code);
    stream.end();
    return;
  }

  if (command === 'flood') {
    // Vuelca datos hasta que el cliente mata el proceso (test de maxBytes).
    let killed = false;
    req.onSignal(() => {
      killed = true;
    });
    const chunk = 'x'.repeat(4096) + '\n';
    const timer = setInterval(() => {
      if (killed || stream.destroyed) {
        clearInterval(timer);
        stream.end();
        return;
      }
      stream.write(chunk);
    }, 1);
    timer.unref?.();
    return;
  }

  if (command === 'hang') {
    // Nunca termina por sí mismo: el timeout del cliente debe matarlo.
    req.onSignal(() => {
      stream.exit(137);
      stream.end();
    });
    return;
  }

  if (command === 'cat') {
    // Devuelve lo que llegue por stdin (test del parámetro `stdin`).
    let input = '';
    stream.on('data', (chunk: Buffer) => {
      input += chunk.toString();
    });
    stream.on('end', () => {
      stream.write(input);
      stream.exit(0);
      stream.end();
    });
    return;
  }

  stream.write(`${command}\n`);
  stream.exit(0);
  stream.end();
}

/** Subsistema SFTP mínimo respaldado por el filesystem real. */
function handleSftp(accept: () => import('ssh2').SFTPWrapper): void {
  const sftp = accept();
  const handles = new Map<string, { path: string; write: boolean }>();
  let nextHandle = 0;

  const makeHandle = (path: string, write: boolean): Buffer => {
    const id = String(nextHandle++);
    handles.set(id, { path, write });
    return Buffer.from(id);
  };

  const STATUS_OK = 0;
  const STATUS_FAILURE = 4;

  sftp.on('OPEN', (reqid, filename, flags) => {
    // ssh2 expone las flags en el formato de OPEN_MODE; basta distinguir
    // lectura de escritura para respaldarlo con streams de Node.
    const write = (flags & 0x0000000a) !== 0; // WRITE | CREAT
    try {
      if (!write) statSync(filename);
      sftp.handle(reqid, makeHandle(filename, write));
    } catch {
      sftp.status(reqid, STATUS_FAILURE);
    }
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const entry = handles.get(handle.toString());
    if (!entry) {
      sftp.status(reqid, STATUS_FAILURE);
      return;
    }
    const stream = createWriteStream(entry.path, {
      flags: offset === 0 ? 'w' : 'r+',
      start: offset,
    });
    stream.on('error', () => sftp.status(reqid, STATUS_FAILURE));
    stream.end(data, () => sftp.status(reqid, STATUS_OK));
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const entry = handles.get(handle.toString());
    if (!entry) {
      sftp.status(reqid, STATUS_FAILURE);
      return;
    }
    const chunks: Buffer[] = [];
    const stream = createReadStream(entry.path, { start: offset, end: offset + length - 1 });
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('error', () => sftp.status(reqid, STATUS_FAILURE));
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0)
        sftp.status(reqid, 1); // EOF
      else sftp.data(reqid, buf);
    });
  });

  const sendAttrs = (reqid: number, path: string): void => {
    try {
      const info = statSync(path);
      sftp.attrs(reqid, {
        mode: info.mode,
        uid: 0,
        gid: 0,
        size: info.size,
        atime: Math.floor(info.atimeMs / 1000),
        mtime: Math.floor(info.mtimeMs / 1000),
      });
    } catch {
      sftp.status(reqid, STATUS_FAILURE);
    }
  };

  sftp.on('STAT', (reqid, path) => sendAttrs(reqid, path));
  sftp.on('LSTAT', (reqid, path) => sendAttrs(reqid, path));
  sftp.on('FSTAT', (reqid, handle) => {
    const entry = handles.get(handle.toString());
    if (!entry) sftp.status(reqid, STATUS_FAILURE);
    else sendAttrs(reqid, entry.path);
  });
  sftp.on('REALPATH', (reqid, path) => {
    const attrs = { mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
    sftp.name(reqid, [{ filename: path, longname: path, attrs }]);
  });
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_OK));
  sftp.on('CLOSE', (reqid, handle) => {
    handles.delete(handle.toString());
    sftp.status(reqid, STATUS_OK);
  });
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  // RSA en PEM PKCS#1: el formato que `ssh2.utils.parseKey` acepta sin ambigüedad.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const fingerprint = fingerprintOf(parsed.getPublicSSH());

  let connections = 0;
  const onExec = opts.onExec ?? defaultExec;

  const server = new Server({ hostKeys: [privateKey] }, (client: Connection) => {
    connections++;

    client.on('authentication', (ctx) => {
      if (opts.rejectAuth) {
        ctx.reject();
        return;
      }
      if (opts.password !== undefined) {
        if (ctx.method === 'password' && ctx.password === opts.password) ctx.accept();
        else ctx.reject(['password']);
        return;
      }
      ctx.accept();
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();

        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          const signalHandlers: ((name: string) => void)[] = [];
          session.on('signal', (_a, _r, sigInfo) => {
            for (const handler of signalHandlers) handler(sigInfo.name);
          });
          onExec({
            command: info.command,
            stream,
            onSignal: (cb) => signalHandlers.push(cb),
          });
        });

        if (opts.sftp !== false) {
          session.on('sftp', (acceptSftp) => handleSftp(acceptSftp));
        }
      });

      if (opts.allowForward) {
        // Jump host: el bastión abre un socket TCP real hacia el destino.
        client.on('tcpip', (acceptForward, _reject, info) => {
          const channel = acceptForward();
          void import('net').then(({ connect }) => {
            const socket = connect(info.destPort, info.destIP, () => {
              channel.pipe(socket).pipe(channel);
            });
            socket.on('error', () => channel.end());
          });
        });
      }
    });

    client.on('error', () => {
      /* desconexiones abruptas en los tests son normales */
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address !== null && typeof address === 'object' ? address.port : 0);
    });
  });

  return {
    port,
    fingerprint,
    connectionCount: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
