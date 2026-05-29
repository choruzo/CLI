import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { IProvider } from '../providers/base.js';
import type { Message } from './types.js';

// ---------------------------------------------------------------------------
// Tipos públicos — §12.13
// ---------------------------------------------------------------------------

export type InitEvent =
  | { type: 'scan_progress'; file: string }
  | { type: 'section_ready'; section: string; content: string }
  | { type: 'merge_conflict'; section: string; existing: string; proposed: string }
  | { type: 'merge_conflict_resolved'; section: string; kept: 'existing' | 'proposed' }
  | { type: 'done'; path: string; isNew: boolean }
  | { type: 'error'; message: string };

export interface InitOptions {
  force?: boolean;
  dryRun?: boolean;
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
  'package-lock.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
];

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
];

const SECTION_PLACEHOLDERS: Record<string, string> = {
  Proyecto: '<!-- Nombre del proyecto, descripción breve, propósito principal -->',
  'Stack Tecnológico': '<!-- Lenguajes, frameworks, librerías principales, versiones clave -->',
  Estructura: '<!-- Árbol de directorios relevante con descripción de cada carpeta -->',
  Convenciones: '<!-- Estilo de código, naming, reglas de commits, patrones detectados -->',
  'Comandos Clave':
    '<!-- Scripts de build, test, dev, lint — exactamente como aparecen en el manifiesto -->',
};

// ---------------------------------------------------------------------------
// InitAgent
// ---------------------------------------------------------------------------

export class InitAgent {
  constructor(
    private readonly provider: IProvider,
    private readonly model: string,
  ) {}

  async *run(cwd: string, options: InitOptions = {}): AsyncGenerator<InitEvent> {
    const stratumMdPath = join(cwd, 'STRATUM.md');
    const isNew = !existsSync(stratumMdPath);

    // -----------------------------------------------------------------------
    // 1. Scan del proyecto
    // -----------------------------------------------------------------------
    const scanData = await this.scan(cwd, options);
    for (const file of scanData.scannedFiles) {
      yield { type: 'scan_progress', file };
    }

    // -----------------------------------------------------------------------
    // 2. Síntesis vía LLM
    // -----------------------------------------------------------------------
    let generatedSections: Record<string, string>;
    try {
      generatedSections = await this.synthesize(cwd, scanData);
    } catch (err) {
      yield { type: 'error', message: `Error generando STRATUM.md: ${String(err)}` };
      return;
    }

    for (const [section, content] of Object.entries(generatedSections)) {
      yield { type: 'section_ready', section, content };
    }

    // -----------------------------------------------------------------------
    // 3. Merge con STRATUM.md existente (una sola pasada)
    // -----------------------------------------------------------------------
    let finalContent: string;

    if (!isNew && !options.force) {
      const existing = readFileSync(stratumMdPath, 'utf-8');

      const mergeGen = this.performMerge(existing, generatedSections, options);
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
      finalContent = this.buildStratumMd(generatedSections);
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
  // Scan
  // -------------------------------------------------------------------------

  private async scan(cwd: string, _options: InitOptions): Promise<ScanData> {
    const scannedFiles: string[] = [];
    const manifests: Record<string, string> = {};
    const configs: Record<string, string> = {};
    const docs: Record<string, string> = {};
    const ciFiles: Record<string, string> = {};

    // Leer .gitignore ANTES de construir el árbol para aplicarlo al scan.
    // Conservar negaciones (!) — se procesan en orden dentro de isGitignored.
    let gitignorePatterns: string[] = [];
    const gitignorePath = join(cwd, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        gitignorePatterns = readFileSync(gitignorePath, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
      } catch {
        // ignorar
      }
    }

    const dirTree = this.buildDirTree(cwd, 0, 3, gitignorePatterns, '');

    // Leer manifiestos
    for (const name of MANIFEST_FILES) {
      if (this.isGitignored(name, gitignorePatterns)) continue;
      const path = join(cwd, name);
      if (existsSync(path)) {
        scannedFiles.push(name);
        try {
          const content = readFileSync(path, 'utf-8');
          manifests[name] =
            name === 'CHANGELOG.md'
              ? content.split('\n').slice(0, 50).join('\n')
              : content.slice(0, 4000);
        } catch {
          // ignorar errores de lectura
        }
      }
    }

    // Leer configs conocidas
    for (const name of CONFIG_FILES) {
      if (this.isGitignored(name, gitignorePatterns)) continue;
      const path = join(cwd, name);
      if (existsSync(path)) {
        scannedFiles.push(name);
        try {
          configs[name] = readFileSync(path, 'utf-8').slice(0, 2000);
        } catch {
          // ignorar
        }
      }
    }

    // Leer .github/workflows/*.yml (CI/CD) — §12.13 paso 3
    const workflowsDir = join(cwd, '.github', 'workflows');
    if (existsSync(workflowsDir) && !this.isGitignored('.github/workflows', gitignorePatterns)) {
      try {
        const ymlFiles = readdirSync(workflowsDir).filter(
          (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
        );
        for (const f of ymlFiles) {
          const relPath = `.github/workflows/${f}`;
          if (this.isGitignored(relPath, gitignorePatterns)) continue;
          scannedFiles.push(relPath);
          try {
            ciFiles[f] = readFileSync(join(workflowsDir, f), 'utf-8').slice(0, 1000);
          } catch {
            // ignorar
          }
        }
      } catch {
        // ignorar
      }
    }

    // Leer docs
    for (const name of DOC_FILES) {
      if (this.isGitignored(name, gitignorePatterns)) continue;
      const path = join(cwd, name);
      if (existsSync(path)) {
        scannedFiles.push(name);
        try {
          const content = readFileSync(path, 'utf-8');
          docs[name] = name.includes('CHANGELOG')
            ? content.split('\n').slice(0, 50).join('\n')
            : content.slice(0, 3000);
        } catch {
          // ignorar
        }
      }
    }

    // Leer entry points — §12.13 paso 5
    const entryPoints: Record<string, string> = {};

    // package.json: "main" y "bin"
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
          if (this.isGitignored(ep, gitignorePatterns)) continue;
          const epPath = join(cwd, ep);
          if (existsSync(epPath)) {
            scannedFiles.push(ep);
            try {
              entryPoints[ep] = readFileSync(epPath, 'utf-8').slice(0, 1000);
            } catch {
              // ignorar
            }
          }
        }
      } catch {
        // JSON inválido
      }
    }

    // pyproject.toml: [tool.poetry.scripts]
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

    // Rust / Go: entry points estáticos — §12.13 paso 5
    for (const ep of ['src/main.rs', 'cmd/main.go', 'main.go']) {
      if (this.isGitignored(ep, gitignorePatterns)) continue;
      const epPath = join(cwd, ep);
      if (existsSync(epPath)) {
        scannedFiles.push(ep);
        try {
          entryPoints[ep] = readFileSync(epPath, 'utf-8').slice(0, 1000);
        } catch {
          // ignorar
        }
      }
    }

    return {
      scannedFiles,
      manifests,
      configs,
      docs,
      ciFiles,
      entryPoints,
      dirTree,
      gitignorePatterns,
    };
  }

  private buildDirTree(
    dir: string,
    depth: number,
    maxDepth: number,
    gitignorePatterns: string[],
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
        const isIgnored = this.isGitignored(relPath, gitignorePatterns);
        if (isIgnored && !this.hasNegatedDescendants(relPath, gitignorePatterns)) continue;
        lines.push(`${indent}${entry}/`);
        const sub = this.buildDirTree(fullPath, depth + 1, maxDepth, gitignorePatterns, relPath);
        if (sub) lines.push(sub);
      }
    }

    return lines.join('\n');
  }

  /**
   * Evalúa si una ruta relativa (desde cwd, separador `/`) está ignorada según
   * los patrones de .gitignore. Procesa los patrones en orden para que las
   * negaciones `!pattern` anulen exclusiones previas (comportamiento real de git).
   * Soporta: nombres simples, wildcards `*`/`**`, rutas con `/`.
   */
  private isGitignored(relPath: string, patterns: string[]): boolean {
    const normalizedPath = this.normalizeGitignorePath(relPath);
    const segments = normalizedPath ? normalizedPath.split('/') : [];
    let ignored = false;

    for (const raw of patterns) {
      const isNegation = raw.startsWith('!');
      const stripped = isNegation ? raw.slice(1) : raw;
      const rootAnchored = stripped.startsWith('/');
      const pattern = this.normalizeGitignorePath(stripped);
      if (!pattern) continue;

      const matches = rootAnchored
        ? this.matchesRootAnchoredPattern(normalizedPath, pattern)
        : pattern.includes('/')
          ? this.matchesPathOrAncestor(normalizedPath, pattern)
          : segments.some((segment) => this.matchGlob(segment, pattern));

      if (matches) ignored = !isNegation;
    }
    return ignored;
  }

  private hasNegatedDescendants(relPath: string, patterns: string[]): boolean {
    const normalizedPath = this.normalizeGitignorePath(relPath);
    const prefix = normalizedPath ? `${normalizedPath}/` : '';

    return patterns.some((pattern) => {
      if (!pattern.startsWith('!')) return false;
      const normalized = this.normalizeGitignorePath(pattern.slice(1));
      return Boolean(normalized) && normalized.startsWith(prefix);
    });
  }

  private matchesRootAnchoredPattern(relPath: string, pattern: string): boolean {
    const candidates = this.listPathCandidates(relPath);
    return candidates.some((candidate) => {
      if (!candidate) return false;
      if (this.matchGlob(candidate, pattern)) return true;
      return pattern.includes('/') ? false : candidate.split('/')[0] === pattern;
    });
  }

  private matchesPathOrAncestor(relPath: string, pattern: string): boolean {
    return this.listPathCandidates(relPath).some((candidate) => this.matchGlob(candidate, pattern));
  }

  private listPathCandidates(relPath: string): string[] {
    const normalizedPath = this.normalizeGitignorePath(relPath);
    if (!normalizedPath) return [];

    const candidates = [normalizedPath];
    const segments = normalizedPath.split('/');
    for (let i = segments.length - 1; i > 0; i--) {
      candidates.push(segments.slice(0, i).join('/'));
    }

    return candidates;
  }

  private normalizeGitignorePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  }

  /** Convierte un glob básico (con `*` y `**`) a RegExp y evalúa la cadena. */
  private matchGlob(str: string, pattern: string): boolean {
    // Dividir en segmentos `**` para procesarlos por separado
    const regexStr = pattern
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*');
    try {
      return new RegExp(`^${regexStr}$`).test(str);
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Síntesis vía LLM
  // -------------------------------------------------------------------------

  private async synthesize(cwd: string, data: ScanData): Promise<Record<string, string>> {
    const contextLines: string[] = [
      `Directorio de trabajo: ${cwd}`,
      '',
      '## Estructura de directorios',
      data.dirTree || '(vacío)',
      '',
    ];

    for (const [name, content] of Object.entries(data.manifests)) {
      contextLines.push(`## ${name}`, '```', content, '```', '');
    }

    for (const [name, content] of Object.entries(data.docs)) {
      contextLines.push(`## ${name}`, content, '');
    }

    for (const [name, content] of Object.entries(data.configs)) {
      contextLines.push(`## ${name} (resumen)`, content.slice(0, 500), '');
    }

    if (Object.keys(data.ciFiles).length > 0) {
      contextLines.push('## CI/CD (.github/workflows)');
      for (const [name, content] of Object.entries(data.ciFiles)) {
        contextLines.push(`### ${name}`, '```yaml', content, '```', '');
      }
    }

    if (Object.keys(data.entryPoints).length > 0) {
      contextLines.push('## Entry points');
      for (const [name, content] of Object.entries(data.entryPoints)) {
        if (name.startsWith('pyproject:')) {
          contextLines.push(`- ${name.slice('pyproject:'.length)}: ${content}`);
        } else {
          contextLines.push(`### ${name}`, '```', content, '```', '');
        }
      }
      contextLines.push('');
    }

    const contextStr = contextLines.join('\n');

    const prompt = `Analiza el siguiente proyecto y genera las 5 secciones de un archivo STRATUM.md.

CONTEXTO DEL PROYECTO:
${contextStr}

Genera EXACTAMENTE las 5 secciones en este orden, usando encabezados H2 (##):
1. ## Proyecto — nombre, descripción breve, propósito principal
2. ## Stack Tecnológico — lenguajes, frameworks, librerías principales, versiones clave
3. ## Estructura — árbol de directorios relevante con descripción de cada carpeta
4. ## Convenciones — estilo de código, naming, reglas de commits, patrones detectados
5. ## Comandos Clave — scripts de build, test, dev, lint exactamente como aparecen en el manifiesto

Empieza directamente con "## Proyecto" sin preámbulo. Sé conciso y técnico.`;

    const messages: Message[] = [{ role: 'user', content: prompt }];
    let rawResponse = '';

    for await (const chunk of this.provider.complete({
      messages,
      stream: true,
      model: this.model,
      signal: AbortSignal.timeout(300000),
    })) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) rawResponse += content;
    }

    return this.parseGeneratedSections(rawResponse);
  }

  private parseGeneratedSections(raw: string): Record<string, string> {
    const sections: Record<string, string> = {};

    const regex = /^## (.+)$/gm;
    const matches = [...raw.matchAll(regex)];

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const sectionName = match[1]!.trim();
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[i + 1]?.index ?? raw.length;
      const content = raw.slice(start, end).trim();
      sections[sectionName] = content;
    }

    for (const fixed of FIXED_SECTIONS) {
      if (!(fixed in sections)) {
        sections[fixed] = '';
      }
    }

    return sections;
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
        result[fixed] = update
          ? this.mergeContent(existingContent, proposedContent)
          : existingContent;
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

  private mergeContent(existing: string, proposed: string): string {
    const existingLines = new Set(
      existing
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const newLines = proposed.split('\n').filter((l) => !existingLines.has(l.trim()) && l.trim());

    if (newLines.length === 0) return existing;
    return `${existing}\n${newLines.join('\n')}`;
  }

  private isPlaceholder(content: string): boolean {
    const trimmed = content.trim();
    return (
      !trimmed ||
      trimmed.startsWith('<!--') ||
      trimmed === '<!-- Describe tu proyecto, stack y convenciones aquí -->'
    );
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

// ---------------------------------------------------------------------------
// Tipos internos del scan
// ---------------------------------------------------------------------------

interface ScanData {
  scannedFiles: string[];
  manifests: Record<string, string>;
  configs: Record<string, string>;
  docs: Record<string, string>;
  ciFiles: Record<string, string>;
  entryPoints: Record<string, string>;
  dirTree: string;
  gitignorePatterns: string[];
}
