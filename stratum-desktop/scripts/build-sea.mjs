#!/usr/bin/env node
/**
 * Construye el sidecar `stratum-core` de Stratum Desktop como Node SEA (15.2).
 *
 *   node scripts/build-sea.mjs            # bundle + SEA + resources + self-test
 *   node scripts/build-sea.mjs --skip-resources   # no recopia node_modules nativos
 *
 * Pasos:
 *  1. `npm run build:desktop` en stratum-cli → `dist-desktop/stratum-core.cjs`
 *     (un único CommonJS con todo el core menos los paquetes nativos).
 *  2. `node --experimental-sea-config` genera el blob de preparación.
 *  3. Copia el ejecutable de Node que corre este script y le inyecta el blob con
 *     postject → `src-tauri/binaries/stratum-core-<target-triple>[.exe]`, que es
 *     el nombre que exige `bundle.externalBin` de Tauri.
 *  4. Copia los paquetes de `stratum-cli/src/desktop/resource-packages.json` y su
 *     clausura de dependencias a `src-tauri/resources/sidecar/node_modules`,
 *     podando lo que no se ejecuta en esta plataforma.
 *  5. Self-test: ejecuta el binario con un PATH sin Node y comprueba que arranca
 *     y que los nativos cargan desde los resources.
 *
 * Los `.node` se usan tal cual los dejó `npm install` en stratum-cli: están
 * compilados para la ABI del Node que ejecuta este script, que es exactamente el
 * runtime que acaba embebido en el SEA. Por eso el binario base es
 * `process.execPath` y no una descarga: un Node distinto rompería la ABI.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const cliRoot = resolve(desktopRoot, '../stratum-cli');
const tauriRoot = join(desktopRoot, 'src-tauri');
const workDir = join(desktopRoot, 'build', 'sea');
const resourcesDir = join(tauriRoot, 'resources');
const sidecarModules = join(resourcesDir, 'sidecar', 'node_modules');

const args = new Set(process.argv.slice(2));
const isWindows = process.platform === 'win32';
const exe = isWindows ? '.exe' : '';

/** Fusible que busca el runtime de Node para saber que lleva un blob SEA inyectado. */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: isWindows, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} → exit ${r.status}`);
}

function targetTriple() {
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const host = /^host: (\S+)$/m.exec(out)?.[1];
    if (host) return host;
  } catch {
    // Sin rustc en el PATH: se deduce de la plataforma de Node.
  }
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const os = { win32: 'pc-windows-msvc', linux: 'unknown-linux-gnu' }[process.platform];
  if (!arch || !os) throw new Error(`Plataforma no soportada: ${process.platform}/${process.arch}`);
  return `${arch}-${os}`;
}

// ---------------------------------------------------------------------------
// 1-3. Bundle, blob e inyección
// ---------------------------------------------------------------------------

async function buildBinary() {
  step('Bundle CommonJS del core (stratum-cli → dist-desktop/stratum-core.cjs)');
  run('npm', ['run', 'build:desktop'], { cwd: cliRoot });
  const bundle = join(cliRoot, 'dist-desktop', 'stratum-core.cjs');

  step('Blob SEA');
  mkdirSync(workDir, { recursive: true });
  const blob = join(workDir, 'sea-prep.blob');
  const seaConfig = join(workDir, 'sea-config.json');
  writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        // La caché de compilación acelera el arranque del sidecar.
        useCodeCache: true,
      },
      null,
      2,
    ),
  );
  run(process.execPath, ['--experimental-sea-config', seaConfig], { shell: false });

  step(`Inyección en una copia de Node ${process.version}`);
  const out = join(tauriRoot, 'binaries', `stratum-core-${targetTriple()}${exe}`);
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  copyFileSync(process.execPath, out);
  // La firma Authenticode de node.exe dejaría de ser válida al inyectar: se
  // quita antes (como indica la documentación de SEA) para que el binario no
  // lleve una firma rota y para que la firma propia del pipeline (D6, si hay
  // certificado) no tropiece con ella.
  if (isWindows) removeAuthenticode(out);
  const { inject } = await import('postject');
  await inject(out, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: SEA_FUSE });
  console.log(`  ${relative(desktopRoot, out)} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  return out;
}

/** `signtool` del PATH o del Windows SDK más reciente; `null` si no hay. */
function findSigntool() {
  const probe = spawnSync('signtool', ['/?'], { stdio: 'ignore', shell: true });
  if (probe.status === 0) return 'signtool';
  const kits = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  if (!existsSync(kits)) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const versions = readdirSync(kits)
    .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const candidate = join(kits, v, arch, 'signtool.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function removeAuthenticode(file) {
  const signtool = findSigntool();
  if (!signtool) {
    console.log('  (sin signtool: el binario conserva la firma de node.exe, que queda inválida)');
    return;
  }
  const r = spawnSync(signtool, ['remove', '/s', file], { encoding: 'utf8', shell: false });
  if (r.status !== 0) {
    console.log(`  (signtool remove falló, se sigue: ${(r.stderr || r.stdout).trim()})`);
  }
}

// ---------------------------------------------------------------------------
// 4. Clausura de dependencias nativas
// ---------------------------------------------------------------------------

/** Resolución de Node: `<dir>/node_modules/<name>`, subiendo hasta la raíz de stratum-cli. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (resolve(dir) === resolve(cliRoot)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Dependencias que solo se usan al INSTALAR un paquete nativo (descargar o
 * compilar su binario), nunca en runtime. No se copian, y tampoco su clausura.
 */
const INSTALL_ONLY = new Set(['prebuild-install', 'node-gyp', 'nan', 'node-addon-api', 'buildcheck']);

function dependencyClosure(roots) {
  const seen = new Map(); // ruta absoluta → nombre
  const queue = roots.map((name) => ({ name, from: cliRoot, optional: false }));
  while (queue.length > 0) {
    const { name, from, optional } = queue.shift();
    if (INSTALL_ONLY.has(name)) continue;
    const pkgDir = resolvePackageDir(name, from);
    if (!pkgDir) {
      // Las opcionales de otras plataformas (sqlite-vec-darwin-*…) no están instaladas.
      if (optional) continue;
      throw new Error(`No se encuentra el paquete ${name} (desde ${relative(cliRoot, from)})`);
    }
    if (seen.has(pkgDir)) continue;
    seen.set(pkgDir, name);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, from: pkgDir, optional: false });
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      queue.push({ name: dep, from: pkgDir, optional: true });
    }
  }
  return [...seen.keys()];
}

/**
 * Poda por paquete: solo lo que se ejecuta en Node y en esta plataforma. Cada
 * entrada es una ruta relativa al paquete que NO se copia.
 */
function prunedPaths(pkgName) {
  const platformDir = `${process.platform}${sep}${process.arch}`;
  switch (pkgName) {
    case '@xenova/transformers':
      // En Node se carga `src/` (`main`); `dist/` son los bundles de navegador.
      return ['dist', 'types'];
    case 'better-sqlite3':
      // Fuentes de SQLite y del addon: el binario ya está en build/Release.
      return ['deps', 'src', 'docs'];
    case 'sharp':
      return ['src'];
    case 'onnxruntime-web': {
      // transformers.js lo importa, pero en Node ejecuta con onnxruntime-node:
      // de `dist/` basta la entrada `main`. Los .wasm y los bundles de navegador
      // (~50 MB) no se cargan nunca.
      const main = join('dist', 'ort-web.node.js');
      return (rel) => rel.startsWith('dist' + sep) && rel !== main;
    }
    case 'cpu-features':
      return ['deps', 'src'];
    case 'onnxruntime-node': {
      // bin/napi-v3/<plataforma>/<arch>: se conserva solo la rama de esta
      // plataforma, incluidos sus directorios padre (el filtro de cpSync no
      // desciende a un directorio descartado).
      const keep = join('bin', 'napi-v3', platformDir);
      return (rel) =>
        rel.startsWith(join('bin', 'napi-v3') + sep) &&
        !keep.startsWith(rel) &&
        !rel.startsWith(keep);
    }
    default:
      return [];
  }
}

/**
 * Convención `prebuilds/<so>-<arch>[+<arch>…]` (node-gyp-build, prebuildify):
 * ¿es la carpeta de otra plataforma? Las carpetas que no siguen la convención
 * se conservan. Además de peso, evita que linuxdeploy (AppImage) pase `ldd` por
 * binarios de Android o iOS (`bare-fs`, vía `tar-fs` de sharp) y aborte.
 */
function isForeignPrebuild(rel, platform = process.platform, arch = process.arch) {
  const parts = rel.split(sep);
  const i = parts.indexOf('prebuilds');
  if (i === -1 || i + 1 >= parts.length) return false;
  // Admite sufijos de variante: `ios-arm64-simulator`, `linux-x64-musl`…
  const m = /^([a-z0-9]+)-([a-z0-9+]+)(?:-[a-z0-9-]+)?$/.exec(parts[i + 1]);
  if (!m) return false;
  return m[1] !== platform || !m[2].split('+').includes(arch);
}

function copyPackage(pkgDir, name) {
  const target = join(sidecarModules, relative(join(cliRoot, 'node_modules'), pkgDir));
  const prune = prunedPaths(name);
  cpSync(pkgDir, target, {
    recursive: true,
    // Los paquetes anidados se copian aparte como parte de la clausura.
    filter: (src) => {
      const rel = relative(pkgDir, src);
      if (rel === '') return true;
      if (rel.split(sep)[0] === 'node_modules') return false;
      if (src.endsWith('.map')) return false;
      if (isForeignPrebuild(rel)) return false;
      if (typeof prune === 'function') return !prune(rel);
      return !prune.some((p) => rel === p || rel.startsWith(p + sep));
    },
  });
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

function copyResources() {
  step('Resources nativos (clausura de dependencias)');
  const roots = JSON.parse(
    readFileSync(join(cliRoot, 'src', 'desktop', 'resource-packages.json'), 'utf8'),
  );
  const dirs = dependencyClosure(roots);
  rmSync(join(resourcesDir, 'sidecar'), { recursive: true, force: true });
  // Tauri copia los resources a `target/<perfil>/sidecar` y a los árboles de
  // `target/<perfil>/bundle` (el AppImage se monta sobre el del .deb), y nunca
  // borra lo que ya no está en la fuente: sin esto, un bundle arrastraría
  // ficheros podados. Con resources nuevos, esos bundles están obsoletos.
  for (const profile of ['debug', 'release']) {
    for (const dir of ['sidecar', 'bundle']) {
      rmSync(join(tauriRoot, 'target', profile, dir), { recursive: true, force: true });
    }
  }
  mkdirSync(sidecarModules, { recursive: true });
  let copied = 0;
  for (const dir of dirs) {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
    // Paquetes solo de tipos que algunas dependencias declaran en `dependencies`.
    if (name.startsWith('@types/')) continue;
    copyPackage(dir, name);
    copied++;
  }
  // Ancla del `createRequire` del sidecar (`desktop/natives.ts`).
  writeFileSync(join(resourcesDir, 'sidecar', 'index.cjs'), '// ancla de resolución del sidecar\n');
  console.log(`  ${copied} paquetes, ${(dirSize(sidecarModules) / 1e6).toFixed(1)} MB`);
}

// ---------------------------------------------------------------------------
// 5. Self-test
// ---------------------------------------------------------------------------

function selfTest(binary) {
  step('Self-test del binario sin Node en el PATH');
  // Solo lo imprescindible del sistema: si el sidecar dependiese de un `node`
  // instalado, aquí no lo encontraría.
  const systemPath = isWindows
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot].join(';')
    : '/usr/bin:/bin';
  const r = spawnSync(binary, ['--self-test'], {
    encoding: 'utf8',
    env: {
      PATH: systemPath,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      STRATUM_RESOURCES_DIR: resourcesDir,
    },
  });
  if (r.error) throw r.error;
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`Salida inesperada del self-test:\n${r.stdout}\n${r.stderr}`);
  }
  for (const n of report.natives) console.log(`  ${n.ok ? '✓' : '✗'} ${n.module}${n.ok ? '' : ` — ${n.error}`}`);
  if (!report.core.sea) throw new Error('El binario no se reconoce como SEA (¿falló la inyección?)');
  if (r.status !== 0) throw new Error(`El self-test falló (exit ${r.status})`);
  console.log(`  core ${report.core.version} · node ${report.core.node} · protocolo ${report.core.protocolVersion}`);
}

const binary = await buildBinary();
if (!args.has('--skip-resources')) copyResources();
selfTest(binary);
console.log('\n✓ Sidecar listo');
