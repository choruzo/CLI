import ignore from 'ignore';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import type { IProvider } from '../providers/base.js';
import type { StratumConfig } from '../config/schema.js';
import type { Message } from './types.js';

// ---------------------------------------------------------------------------
// Tipos públicos — §12.13
// ---------------------------------------------------------------------------

export type InitEvent =
  | { type: 'scan_progress'; file: string }
  | { type: 'explorer_step'; iteration: number; action: string; file?: string }
  | { type: 'section_ready'; section: string; content: string }
  | { type: 'merge_conflict'; section: string; existing: string; proposed: string }
  | { type: 'merge_conflict_resolved'; section: string; kept: 'existing' | 'proposed' }
  | { type: 'done'; path: string; isNew: boolean }
  | { type: 'error'; message: string };

export interface InitOptions {
  force?: boolean;
  dryRun?: boolean;
  /** Si es true, omite la fase ReAct Explorer (Hito 2.5). */
  noExplore?: boolean;
  /** Resuelve los conflictos de merge sin interacción (usado en tests). */
  resolveConflict?: (section: string, existing: string, proposed: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Constantes de scan
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.next',
  'build',
  'coverage',
  '.turbo',
]);

const MANIFEST_FILES = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  'deno.json',
  'deno.jsonc',
];

const LOCKFILES: Record<string, string> = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
};

const CONFIG_FILES = [
  'tsconfig.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.yml',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.editorconfig',
  '.nvmrc',
  '.python-version',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Makefile',
];

const DOC_FILES = ['README.md', 'README.rst', 'README.txt', 'CONTRIBUTING.md', 'CHANGELOG.md'];

const FIXED_SECTIONS = [
  'Proyecto',
  'Stack Tecnológico',
  'Estructura',
  'Convenciones',
  'Comandos Clave',
  'Instrucciones para el agente',
];

const SECTION_PLACEHOLDERS: Record<string, string> = {
  Proyecto: '<!-- Nombre del proyecto, descripción breve, propósito principal -->',
  'Stack Tecnológico': '<!-- Lenguajes, frameworks, librerías principales, versiones clave -->',
  Estructura: '<!-- Árbol de directorios relevante con descripción de cada carpeta -->',
  Convenciones: '<!-- Estilo de código, naming, reglas de commits, patrones detectados -->',
  'Comandos Clave':
    '<!-- Scripts de build, test, dev, lint — exactamente como aparecen en el manifiesto -->',
  'Instrucciones para el agente': `<!-- Escribe aquí las instrucciones permanentes que el agente debe respetar en cada sesión.
Ejemplos:
- Confirmar siempre antes de ejecutar comandos destructivos
- Responder en español
- Al tocar archivos de configuración de VMware, mostrar un diff antes de aplicar
- Preferir editar archivos existentes antes de crear nuevos
-->`,
};

const MAX_FILES_PER_DIR = 20;
const CONTEXT_BUDGET_CHARS = 12_000;

// ---------------------------------------------------------------------------
// Tipos internos
// ---------------------------------------------------------------------------

interface ProjectLayout {
  root: string;
  isMonorepo: boolean;
  packages: string[];
}

interface GitMetadata {
  branch: string;
  remote?: string; // ya saneado — sin credenciales
  recentCommits: string[];
}

export interface ScanData {
  scannedFiles: string[];
  manifests: Record<string, string>;
  configs: Record<string, string>;
  docs: Record<string, string>;
  ciFiles: Record<string, string>;
  entryPoints: Record<string, string>;
  dirTree: string;
  packageManager?: string;
  projectRoot: string;
  isMonorepo: boolean;
  packages: string[];
  git?: GitMetadata;
}

// ---------------------------------------------------------------------------
// InitAgent
// ---------------------------------------------------------------------------

export class InitAgent {
  private readonly providerInfo?: { name: string; baseUrl: string };
  private readonly config?: StratumConfig;
  private readonly contextWindow?: number;

  constructor(
    private readonly provider: IProvider,
    private readonly model: string,
    opts?: {
      providerInfo?: { name: string; baseUrl: string };
      config?: StratumConfig;
      contextWindow?: number;
    },
  ) {
    this.providerInfo = opts?.providerInfo;
    this.config = opts?.config;
    this.contextWindow = opts?.contextWindow;
  }

  async *run(cwd: string, options: InitOptions = {}): AsyncGenerator<InitEvent> {
    const stratumMdPath = join(cwd, 'STRATUM.md');
    const isNew = !existsSync(stratumMdPath);

    // -----------------------------------------------------------------------
    // 0. Detectar raíz real del proyecto (monorepos, proyectos anidados)
    // -----------------------------------------------------------------------
    const ig = this.buildIgnore(cwd);
    const layout = this.detectProjectRoot(cwd, ig);

    // -----------------------------------------------------------------------
    // 1. Scan del proyecto
    // -----------------------------------------------------------------------
    const scanData = await this.scan(layout, cwd, options);
    for (const file of scanData.scannedFiles) {
      yield { type: 'scan_progress', file };
    }

    // -----------------------------------------------------------------------
    // 1.5. ReAct Explorer — Fase 2 (Hito 2.5, §569)
    // -----------------------------------------------------------------------
    let explorerFindings: { filesRead: string[]; findings: string } | undefined;
    if (!options.noExplore && this.config !== undefined && this.contextWindow !== undefined) {
      try {
        const { InitReActExplorer } = await import('./init-explorer.js');
        const explorer = new InitReActExplorer(
          this.provider,
          this.model,
          this.config,
          this.contextWindow,
        );
        const gen = explorer.explore(scanData, cwd);
        while (true) {
          const step = await gen.next();
          if (step.done) {
            explorerFindings = step.value;
            break;
          }
          yield step.value;
        }
      } catch {
        // Degradar silenciosamente: continuar sin hallazgos del explorer
      }
    }

    // -----------------------------------------------------------------------
    // 2. Síntesis vía LLM + secciones deterministas
    // -----------------------------------------------------------------------
    let generatedSections: Record<string, string>;
    try {
      generatedSections = await this.synthesize(scanData, explorerFindings);
    } catch (err) {
      const msg = String(err);
      const isNetworkError =
        msg.includes('fetch failed') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('connect ETIMEDOUT');

      if (isNetworkError) {
        const name = this.providerInfo?.name ?? 'desconocido';
        const baseUrl = this.providerInfo?.baseUrl ?? 'desconocida';
        yield {
          type: 'error',
          message:
            `No se pudo conectar al proveedor LLM "${name}" (${baseUrl}).\n` +
            `  Verifica que el servidor esté corriendo y accesible.\n` +
            `  Si usas Ollama: ejecuta \`ollama serve\` antes de \`stratum init\`.\n` +
            `  Para cambiar el proveedor: edita .stratumrc.json o usa \`stratum config set\`.`,
        };
      } else {
        yield { type: 'error', message: `Error generando STRATUM.md: ${msg}` };
      }
      return;
    }

    // Fusionar con secciones deterministas (Estructura, Comandos Clave)
    const deterministicSections = this.buildDeterministicSections(scanData);
    const allSections = { ...generatedSections, ...deterministicSections };

    for (const [section, content] of Object.entries(allSections)) {
      yield { type: 'section_ready', section, content };
    }

    // -----------------------------------------------------------------------
    // 3. Merge con STRATUM.md existente (una sola pasada)
    // -----------------------------------------------------------------------
    let finalContent: string;

    if (!isNew && !options.force) {
      const existing = readFileSync(stratumMdPath, 'utf-8');

      const mergeGen = this.performMerge(existing, allSections, options);
      let mergedSections!: Record<string, string>;
      while (true) {
        const step = await mergeGen.next();
        if (step.done) {
          mergedSections = step.value;
          break;
        }
        yield step.value;
      }

      finalContent = this.buildStratumMd(mergedSections);
    } else {
      finalContent = this.buildStratumMd(allSections);
    }

    // -----------------------------------------------------------------------
    // 4. Escritura
    // -----------------------------------------------------------------------
    if (!options.dryRun) {
      writeFileSync(stratumMdPath, finalContent, 'utf-8');
    }

    yield { type: 'done', path: stratumMdPath, isNew };
  }

  // -------------------------------------------------------------------------
  // Detección de raíz del proyecto
  // -------------------------------------------------------------------------

  private buildIgnore(cwd: string): ReturnType<typeof ignore> {
    const ig = ignore();
    const gitignorePath = join(cwd, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        ig.add(readFileSync(gitignorePath, 'utf-8'));
      } catch {
        /* ignorar */
      }
    }
    const excludePath = join(cwd, '.git', 'info', 'exclude');
    if (existsSync(excludePath)) {
      try {
        ig.add(readFileSync(excludePath, 'utf-8'));
      } catch {
        /* ignorar */
      }
    }
    return ig;
  }

  /**
   * Si cwd no tiene manifiesto conocido, busca en subdirectorios directos (depth 1).
   * - Raíz con manifiesto → root = cwd, isMonorepo según workspaces/turbo/nx
   * - Raíz sin manifiesto y 1 hijo con manifiesto → root = ese hijo
   * - N>1 hijos con manifiestos → isMonorepo, root = cwd, packages = hijos
   */
  private detectProjectRoot(cwd: string, ig: ReturnType<typeof ignore>): ProjectLayout {
    const hasRootManifest = MANIFEST_FILES.some((f) => existsSync(join(cwd, f)));

    if (hasRootManifest) {
      let isMonorepo = false;
      const packages: string[] = [];

      const pkgPath = join(cwd, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
          if (Array.isArray(pkg['workspaces'])) isMonorepo = true;
        } catch {
          /* ignorar */
        }
      }
      if (!isMonorepo) {
        isMonorepo = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json'].some((f) =>
          existsSync(join(cwd, f)),
        );
      }
      if (isMonorepo) {
        for (const dir of this.listDirs(cwd, ig)) {
          if (MANIFEST_FILES.some((f) => existsSync(join(cwd, dir, f)))) {
            packages.push(dir);
          }
        }
      }
      return { root: cwd, isMonorepo, packages };
    }

    // Sin manifiesto en raíz → buscar en hijos directos
    const childrenWithManifest = this.listDirs(cwd, ig).filter((dir) =>
      MANIFEST_FILES.some((f) => existsSync(join(cwd, dir, f))),
    );

    if (childrenWithManifest.length === 1) {
      return { root: join(cwd, childrenWithManifest[0]!), isMonorepo: false, packages: [] };
    }
    if (childrenWithManifest.length > 1) {
      return { root: cwd, isMonorepo: true, packages: childrenWithManifest };
    }
    return { root: cwd, isMonorepo: false, packages: [] };
  }

  private listDirs(dir: string, ig: ReturnType<typeof ignore>): string[] {
    try {
      return readdirSync(dir)
        .filter((e) => !EXCLUDED_DIRS.has(e) && !ig.ignores(e))
        .filter((e) => {
          try {
            return statSync(join(dir, e)).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  private async scan(
    layout: ProjectLayout,
    _cwd: string,
    _options: InitOptions,
  ): Promise<ScanData> {
    const root = layout.root;
    const scannedFiles: string[] = [];
    const manifests: Record<string, string> = {};
    const configs: Record<string, string> = {};
    const docs: Record<string, string> = {};
    const ciFiles: Record<string, string> = {};

    // Construir instancia de ignore para la raíz real del proyecto (puede diferir de cwd)
    const ig = this.buildIgnore(root);

    const dirTree = this.buildDirTree(root, 0, 3, ig, '');

    // Leer manifiestos
    for (const name of MANIFEST_FILES) {
      if (ig.ignores(name)) continue;
      const path = join(root, name);
      if (existsSync(path)) {
        scannedFiles.push(name);
        try {
          manifests[name] = readFileSync(path, 'utf-8').slice(0, 4000);
        } catch {
          /* ignorar */
        }
      }
    }

    // Detección extra: .csproj / .sln (nombre no fijo)
    try {
      const dotNetFile = readdirSync(root).find((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
      if (dotNetFile && !ig.ignores(dotNetFile)) {
        scannedFiles.push(dotNetFile);
        try {
          manifests[dotNetFile] = readFileSync(join(root, dotNetFile), 'utf-8').slice(0, 4000);
        } catch {
          /* ignorar */
        }
      }
    } catch {
      /* ignorar */
    }

    // Detectar gestor de paquetes por lockfile (solo presencia, no contenido)
    let packageManager: string | undefined;
    for (const [lockfile, manager] of Object.entries(LOCKFILES)) {
      if (existsSync(join(root, lockfile))) {
        packageManager = manager;
        scannedFiles.push(lockfile);
        break;
      }
    }

    // Leer configs conocidas
    for (const name of CONFIG_FILES) {
      if (ig.ignores(name)) continue;
      const path = join(root, name);
      if (existsSync(path)) {
        scannedFiles.push(name);
        try {
          configs[name] = readFileSync(path, 'utf-8').slice(0, 2000);
        } catch {
          /* ignorar */
        }
      }
    }

    // Leer .github/workflows/*.yml (CI/CD) — §12.13 paso 3
    const workflowsDir = join(root, '.github', 'workflows');
    if (existsSync(workflowsDir) && !ig.ignores('.github/workflows')) {
      try {
        const ymlFiles = readdirSync(workflowsDir).filter(
          (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
        );
        for (const f of ymlFiles) {
          const relPath = `.github/workflows/${f}`;
          if (ig.ignores(relPath)) continue;
          scannedFiles.push(relPath);
          try {
            ciFiles[f] = readFileSync(join(workflowsDir, f), 'utf-8').slice(0, 1000);
          } catch {
            /* ignorar */
          }
        }
      } catch {
        /* ignorar */
      }
    }

    // Leer docs
    for (const name of DOC_FILES) {
      if (ig.ignores(name)) continue;
      const path = join(root, name);
      if (existsSync(path)) {
        scannedFiles.push(name);
        try {
          const content = readFileSync(path, 'utf-8');
          docs[name] = name.includes('CHANGELOG')
            ? content.split('\n').slice(0, 50).join('\n')
            : content.slice(0, 3000);
        } catch {
          /* ignorar */
        }
      }
    }

    // Leer entry points — §12.13 paso 5
    const entryPoints: Record<string, string> = {};

    if (manifests['package.json']) {
      try {
        const pkg = JSON.parse(manifests['package.json']) as Record<string, unknown>;
        const candidates: string[] = [];
        if (typeof pkg['main'] === 'string') candidates.push(pkg['main']);
        if (typeof pkg['bin'] === 'string') candidates.push(pkg['bin']);
        if (typeof pkg['bin'] === 'object' && pkg['bin']) {
          candidates.push(...Object.values(pkg['bin'] as Record<string, string>));
        }
        for (const ep of candidates) {
          if (ig.ignores(ep)) continue;
          const epPath = join(root, ep);
          if (existsSync(epPath)) {
            scannedFiles.push(ep);
            try {
              entryPoints[ep] = readFileSync(epPath, 'utf-8').slice(0, 1000);
            } catch {
              /* ignorar */
            }
          }
        }
      } catch {
        /* ignorar */
      }
    }

    if (manifests['pyproject.toml']) {
      const scriptMatch = manifests['pyproject.toml'].match(
        /\[tool\.poetry\.scripts\]([\s\S]*?)(?=\n\[|$)/,
      );
      if (scriptMatch?.[1]) {
        for (const line of scriptMatch[1].trim().split('\n')) {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
            const scriptName = line.slice(0, eqIdx).trim();
            entryPoints[`pyproject:${scriptName}`] = line.trim();
          }
        }
      }
    }

    for (const ep of ['src/main.rs', 'cmd/main.go', 'main.go']) {
      if (ig.ignores(ep)) continue;
      const epPath = join(root, ep);
      if (existsSync(epPath)) {
        scannedFiles.push(ep);
        try {
          entryPoints[ep] = readFileSync(epPath, 'utf-8').slice(0, 1000);
        } catch {
          /* ignorar */
        }
      }
    }

    // Metadatos de Git
    const git = await this.readGitMetadata(root);

    return {
      scannedFiles,
      manifests,
      configs,
      docs,
      ciFiles,
      entryPoints,
      dirTree,
      packageManager,
      projectRoot: root,
      isMonorepo: layout.isMonorepo,
      packages: layout.packages,
      git,
    };
  }

  private buildDirTree(
    dir: string,
    depth: number,
    maxDepth: number,
    ig: ReturnType<typeof ignore>,
    relDir: string,
  ): string {
    if (depth >= maxDepth) return '';
    const lines: string[] = [];
    let entries: string[] = [];

    try {
      entries = readdirSync(dir).sort();
    } catch {
      return '';
    }

    const fileEntries: string[] = [];

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      const indent = '  '.repeat(depth);

      if (stat.isDirectory()) {
        // Con la librería `ignore`, no podamos un directorio a menos que todas sus rutas
        // hijas también estén ignoradas. Probamos si el directorio en sí está ignorado
        // sin verificar rutas hijas (la librería maneja negaciones correctamente).
        if (ig.ignores(relPath)) continue;
        lines.push(`${indent}${entry}/`);
        const sub = this.buildDirTree(fullPath, depth + 1, maxDepth, ig, relPath);
        if (sub) lines.push(sub);
      } else if (depth <= 2) {
        if (ig.ignores(relPath)) continue;
        fileEntries.push(`${indent}${entry}`);
      }
    }

    // Añadir archivos después de directorios, con límite
    if (fileEntries.length > 0) {
      const slice = fileEntries.slice(0, MAX_FILES_PER_DIR);
      const overflow = fileEntries.length - slice.length;
      lines.push(...slice);
      if (overflow > 0) lines.push(`${'  '.repeat(depth)}  … +${overflow} más`);
    }

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Metadatos de Git con saneo de credenciales — §1.5
  // -------------------------------------------------------------------------

  private async readGitMetadata(root: string): Promise<GitMetadata | undefined> {
    try {
      const branchResult = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: root,
        reject: false,
      });
      if (branchResult.exitCode !== 0) return undefined;
      const branch = branchResult.stdout.trim();

      let remote: string | undefined;
      try {
        const remoteResult = await execa('git', ['remote', 'get-url', 'origin'], {
          cwd: root,
          reject: false,
        });
        if (remoteResult.exitCode === 0) {
          const rawRemote = remoteResult.stdout.trim();
          // Saneo OBLIGATORIO: eliminar credenciales user:token@ de URLs https
          remote = rawRemote.replace(/https?:\/\/[^@]+@/, 'https://');
        }
      } catch {
        /* sin remote */
      }

      const logResult = await execa('git', ['log', '--oneline', '-5', '--pretty=format:%s'], {
        cwd: root,
        reject: false,
      });
      const recentCommits =
        logResult.exitCode === 0 ? logResult.stdout.trim().split('\n').filter(Boolean) : [];

      return { branch, remote, recentCommits };
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Fallback por extensiones — §1.3
  // -------------------------------------------------------------------------

  private collectExtensionStats(root: string): Record<string, number> {
    const srcDir = existsSync(join(root, 'src')) ? join(root, 'src') : root;
    const counts: Record<string, number> = {};
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      try {
        for (const entry of readdirSync(dir)) {
          if (EXCLUDED_DIRS.has(entry)) continue;
          const full = join(dir, entry);
          try {
            const s = statSync(full);
            if (s.isDirectory()) walk(full, depth + 1);
            else {
              const ext = entry.includes('.') ? `.${entry.split('.').pop()}` : '(sin extensión)';
              counts[ext] = (counts[ext] ?? 0) + 1;
            }
          } catch {
            /* ignorar */
          }
        }
      } catch {
        /* ignorar */
      }
    };
    walk(srcDir, 0);
    return Object.fromEntries(
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    );
  }

  // -------------------------------------------------------------------------
  // Secciones deterministas — §2.2
  // -------------------------------------------------------------------------

  private buildDeterministicSections(data: ScanData): Record<string, string> {
    const sections: Record<string, string> = {};

    // Estructura — árbol real
    sections['Estructura'] = data.dirTree
      ? `\`\`\`\n${data.dirTree}\n\`\`\``
      : SECTION_PLACEHOLDERS['Estructura']!;

    // Comandos Clave — extraídos del manifiesto
    const runner = data.packageManager ?? 'npm';
    const cmds: string[] = [];

    if (data.manifests['package.json']) {
      try {
        const pkg = JSON.parse(data.manifests['package.json']) as Record<string, unknown>;
        const scripts = pkg['scripts'] as Record<string, string> | undefined;
        if (scripts) {
          for (const [name, cmd] of Object.entries(scripts)) {
            cmds.push(`${runner} run ${name}   # ${cmd}`);
          }
        }
      } catch {
        /* ignorar */
      }
    }

    if (data.configs['Makefile']) {
      const targets = data.configs['Makefile']
        .split('\n')
        .filter((l) => /^[a-zA-Z][a-zA-Z0-9_-]*:/.test(l))
        .map((l) => `make ${l.split(':')[0]}`);
      cmds.push(...targets);
    }

    sections['Comandos Clave'] = cmds.length
      ? cmds.join('\n')
      : SECTION_PLACEHOLDERS['Comandos Clave']!;

    return sections;
  }

  // -------------------------------------------------------------------------
  // Síntesis vía LLM — §2.3 / §2.4
  // -------------------------------------------------------------------------

  private async synthesize(
    data: ScanData,
    findings?: { filesRead: string[]; findings: string },
  ): Promise<Record<string, string>> {
    // --- Construir contexto con presupuesto de tokens --- §1.7
    const parts: { priority: number; label: string; content: string }[] = [];

    // Prioridad 1: manifiesto principal (hasta 4000 chars — ya limitado en scan)
    const mainManifest = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Gemfile']
      .map((n) => (data.manifests[n] ? { name: n, content: data.manifests[n]! } : null))
      .find(Boolean);
    if (mainManifest) {
      parts.push({
        priority: 1,
        label: `## ${mainManifest.name}`,
        content: `\`\`\`\n${mainManifest.content}\n\`\`\``,
      });
    }

    // Prioridad 2: hallazgos del ReAct Explorer (§593 — siempre incluido, no truncable)
    if (findings && findings.findings && findings.findings !== 'Sin hallazgos adicionales.') {
      const filesNote =
        findings.filesRead.length > 0
          ? `\nArchivos inspeccionados: ${findings.filesRead.join(', ')}`
          : '';
      parts.push({
        priority: 2,
        label: '## Hallazgos del explorer (exploración libre)',
        content: findings.findings + filesNote,
      });
    }

    // Resto de manifiestos
    for (const [name, content] of Object.entries(data.manifests)) {
      if (name === mainManifest?.name) continue;
      parts.push({ priority: 4, label: `## ${name}`, content: `\`\`\`\n${content}\n\`\`\`` });
    }

    // Fallback por extensiones si no hay manifiestos
    if (Object.keys(data.manifests).length === 0) {
      const stats = this.collectExtensionStats(data.projectRoot);
      if (Object.keys(stats).length > 0) {
        const statsStr = Object.entries(stats)
          .map(([ext, count]) => `${ext}: ${count}`)
          .join(', ');
        parts.push({
          priority: 1,
          label: '## Extensiones de archivo detectadas (sin manifiesto conocido)',
          content: statsStr,
        });
      }
    }

    // Docs (prioridad 3)
    for (const [name, content] of Object.entries(data.docs)) {
      parts.push({ priority: 3, label: `## ${name}`, content });
    }

    // Configs (prioridad 4)
    for (const [name, content] of Object.entries(data.configs)) {
      parts.push({ priority: 4, label: `## ${name} (resumen)`, content: content.slice(0, 500) });
    }

    // CI/CD (prioridad 5)
    if (Object.keys(data.ciFiles).length > 0) {
      let ciContent = '';
      for (const [name, content] of Object.entries(data.ciFiles)) {
        ciContent += `### ${name}\n\`\`\`yaml\n${content}\n\`\`\`\n\n`;
      }
      parts.push({ priority: 5, label: '## CI/CD (.github/workflows)', content: ciContent });
    }

    // Entry points (prioridad 6)
    if (Object.keys(data.entryPoints).length > 0) {
      let epContent = '';
      for (const [name, content] of Object.entries(data.entryPoints)) {
        if (name.startsWith('pyproject:')) {
          epContent += `- ${name.slice('pyproject:'.length)}: ${content}\n`;
        } else {
          epContent += `### ${name}\n\`\`\`\n${content}\n\`\`\`\n\n`;
        }
      }
      parts.push({ priority: 6, label: '## Entry points', content: epContent });
    }

    // Aplicar presupuesto de tokens (truncar de menor a mayor prioridad)
    const always = parts.filter((p) => p.priority <= 2);
    const optional = parts.filter((p) => p.priority > 2).sort((a, b) => a.priority - b.priority);

    const alwaysStr = always.map((p) => `${p.label}\n${p.content}`).join('\n\n');
    let contextStr = alwaysStr;
    for (const part of optional) {
      const addition = `\n\n${part.label}\n${part.content}`;
      if ((contextStr + addition).length <= CONTEXT_BUDGET_CHARS) {
        contextStr += addition;
      }
      // si no cabe, se omite (truncación de menor a mayor prioridad)
    }

    // Metadatos de Git
    const gitLines: string[] = [];
    if (data.git) {
      gitLines.push(`## Git`);
      gitLines.push(`Rama por defecto: ${data.git.branch}`);
      if (data.git.remote) gitLines.push(`Remote: ${data.git.remote}`);
      if (data.git.recentCommits.length > 0) {
        gitLines.push(`Commits recientes (inferir convención de mensajes):`);
        for (const c of data.git.recentCommits) gitLines.push(`  - ${c}`);
      }
      contextStr = `${gitLines.join('\n')}\n\n${contextStr}`;
    }

    // Info de monorepo
    if (data.isMonorepo && data.packages.length > 0) {
      const monoInfo = `## Monorepo — paquetes detectados\n${data.packages.join(', ')}`;
      contextStr = `${monoInfo}\n\n${contextStr}`;
    }

    // Gestor de paquetes detectado — §1.4 punto 4
    if (data.packageManager) {
      contextStr = `Gestor de paquetes detectado: ${data.packageManager}\n\n${contextStr}`;
    }

    // --- Prompt --- §2.4
    const prompt = `Eres un asistente técnico que documenta proyectos de software.
Genera SOLO las secciones pedidas. Usa ÚNICAMENTE la evidencia proporcionada.
Si no hay evidencia suficiente para una afirmación, OMÍTELA — nunca inventes convenciones ni versiones.
Responde en español.

HEURÍSTICAS DE STACK (aplica las que correspondan):
  package.json + "typescript" en devDependencies → TypeScript
  "react" + "ink" en dependencies → UI terminal con Ink
  "vitest" o "jest" → framework de test
  gestor detectado por lockfile: pnpm-lock.yaml → pnpm, yarn.lock → yarn, bun.lockb → bun
  Cargo.toml → Rust; go.mod → Go; pyproject.toml → Python; Gemfile → Ruby
  tsup o esbuild en devDependencies → bundler TypeScript
  "execa" → shell commands vía execa (no child_process directo)

EJEMPLO DE SALIDA CORRECTA:
<<<PROYECTO>>>
Stratum CLI — agente de línea de comandos extensible construido sobre un loop ReAct.
Provider-agnostic: compatible con cualquier API OpenAI-compatible (Ollama, llama.cpp, OpenAI).
<<<END>>>

<<<STACK>>>
- TypeScript 5.x (ESM + CJS via tsup)
- Node.js 20+
- Commander.js (CLI), Ink (UI terminal)
- Vitest (tests), ESLint + Prettier (lint/formato)
- sqlite-vec (vector DB), @xenova/transformers (embeddings ONNX)
<<<END>>>

<<<CONVENCIONES>>>
- Archivos: kebab-case; clases: PascalCase (inferido de src/)
- Commits: Conventional Commits (feat:, fix:, chore: — inferido de git log)
- Tests: co-ubicados con el módulo (*.test.ts)
<<<END>>>

Estructura y Comandos Clave se generan de forma determinista; NO los incluyas.

EVIDENCIA DEL PROYECTO:
${contextStr}

Genera las 3 secciones siguiendo exactamente el formato del ejemplo:`;

    const messages: Message[] = [{ role: 'user', content: prompt }];

    // Primera llamada
    let rawResponse = await this.callProvider(messages);
    let parsed = this.parseDelimitedSections(rawResponse);

    // Reintento único si el parse falla
    if (!parsed) {
      const retryMessages: Message[] = [
        ...messages,
        { role: 'assistant', content: rawResponse },
        {
          role: 'user',
          content:
            'ATENCIÓN: Tu respuesta anterior no incluyó los delimitadores <<<CLAVE>>> requeridos. ' +
            'Responde SOLO con los tres bloques delimitados (<<<PROYECTO>>>, <<<STACK>>>, <<<CONVENCIONES>>>), ' +
            'sin texto adicional fuera de ellos.',
        },
      ];
      rawResponse = await this.callProvider(retryMessages);
      parsed = this.parseDelimitedSections(rawResponse);
    }

    // Si tras el reintento sigue fallando, caer a placeholders
    if (!parsed) {
      const fallback: Record<string, string> = {};
      for (const fixed of FIXED_SECTIONS) {
        fallback[fixed] = '';
      }
      return fallback;
    }

    // Rellenar secciones que el LLM no debe generar con string vacío (se asignan luego)
    const result: Record<string, string> = { ...parsed };
    for (const fixed of FIXED_SECTIONS) {
      if (!(fixed in result)) result[fixed] = '';
    }
    return result;
  }

  private async callProvider(messages: Message[]): Promise<string> {
    let raw = '';
    for await (const chunk of this.provider.complete({
      messages,
      stream: true,
      model: this.model,
      temperature: 0.2,
      signal: AbortSignal.timeout(300000),
    })) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) raw += content;
    }
    return raw;
  }

  private parseDelimitedSections(raw: string): Record<string, string> | null {
    const KEY_MAP: Record<string, string> = {
      PROYECTO: 'Proyecto',
      STACK: 'Stack Tecnológico',
      CONVENCIONES: 'Convenciones',
    };
    const result: Record<string, string> = {};

    for (const [key, sectionName] of Object.entries(KEY_MAP)) {
      const match = raw.match(new RegExp(`<<<${key}>>>([\\s\\S]*?)<<<END>>>`, 'i'));
      if (match?.[1]) {
        result[sectionName] = match[1].trim();
      }
    }

    const missing = Object.values(KEY_MAP).filter((s) => !result[s]);
    return missing.length === 0 ? result : null;
  }

  // -------------------------------------------------------------------------
  // Merge — §12.13 (una sola pasada: emite eventos Y devuelve secciones)
  // -------------------------------------------------------------------------

  private async *performMerge(
    existing: string,
    generated: Record<string, string>,
    options: InitOptions,
  ): AsyncGenerator<InitEvent, Record<string, string>> {
    const parsed = this.parseExistingSections(existing);
    const result: Record<string, string> = {};

    for (const fixed of FIXED_SECTIONS) {
      const existingContent = parsed[fixed] ?? '';
      const proposedContent = generated[fixed] ?? '';
      const isManual = existingContent && !this.isPlaceholder(existingContent);

      if (isManual && proposedContent && options.resolveConflict) {
        yield {
          type: 'merge_conflict',
          section: fixed,
          existing: existingContent,
          proposed: proposedContent,
        };
        const update = await options.resolveConflict(fixed, existingContent, proposedContent);
        yield {
          type: 'merge_conflict_resolved',
          section: fixed,
          kept: update ? 'proposed' : 'existing',
        };
        // §2.6: usar la versión propuesta íntegra en lugar de concatenar
        result[fixed] = update ? proposedContent : existingContent;
      } else if (isManual) {
        result[fixed] = existingContent;
      } else {
        result[fixed] = proposedContent || existingContent;
      }
    }

    // Preservar secciones extra del usuario
    for (const [name, content] of Object.entries(parsed)) {
      if (!FIXED_SECTIONS.includes(name)) {
        result[`__extra__${name}`] = content;
      }
    }

    return result;
  }

  private isPlaceholder(content: string): boolean {
    return !content.trim() || content.trim().startsWith('<!--');
  }

  private parseExistingSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const regex = /^## (.+)$/gm;
    const matches = [...content.matchAll(regex)];

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const name = match[1]!.trim();
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[i + 1]?.index ?? content.length;
      sections[name] = content.slice(start, end).trim();
    }

    return sections;
  }

  // -------------------------------------------------------------------------
  // Construcción del STRATUM.md final — §12.13
  // -------------------------------------------------------------------------

  buildStratumMd(sections: Record<string, string>): string {
    const lines: string[] = ['# Stratum Memory', ''];

    // Secciones fijas en orden, con placeholder si están vacías
    for (const name of FIXED_SECTIONS) {
      const content = sections[name] ?? '';
      lines.push(`## ${name}`);
      lines.push(content || SECTION_PLACEHOLDERS[name] || '');
      lines.push('');
    }

    // Secciones extra del usuario
    for (const [key, content] of Object.entries(sections)) {
      if (key.startsWith('__extra__')) {
        const name = key.slice('__extra__'.length);
        lines.push(`## ${name}`);
        if (content) lines.push(content);
        lines.push('');
      }
    }

    return lines.join('\n').trimEnd() + '\n';
  }
}
