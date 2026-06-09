/**
 * Prompt para el comando `stratum init`.
 *
 * Variables que el código reemplaza antes de enviarlo al agente:
 *   ${path}       — ruta absoluta del directorio raíz del proyecto
 *   $ARGUMENTS    — restricciones o foco adicionales del usuario (puede estar vacío)
 *
 * El agente recibe este prompt como mensaje de usuario y usa sus tools
 * (read_file, write_file, bash) para explorar el repo libremente.
 */
export const INITIALIZE_PROMPT = `Create or update \`STRATUM.md\` for the repository at \`\${path}\`.

The goal is a compact instruction file that helps future Stratum agent sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely get this wrong without it?" If not, leave it out.

User-provided focus or constraints (honor these above all else):
$ARGUMENTS

## How to investigate

Use your tools to read the highest-value sources first:
- \`README*\`, root manifests (\`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pyproject.toml\`), workspace config, lockfiles
- build, test, lint, formatter, typecheck, and codegen config (\`tsconfig.json\`, \`Makefile\`, \`.eslintrc*\`, etc.)
- CI workflows (\`.github/workflows/\`)
- existing instruction files (\`STRATUM.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, \`.cursorrules\`)

If the project structure is still unclear after reading config and docs, read a small number of representative source files to understand entrypoints, package boundaries, and execution flow.

Prefer executable sources of truth over prose. If docs conflict with scripts or config, trust the executable source.

## What to extract

Look for the highest-signal facts for an agent working in this repo:
- Exact developer commands, especially non-obvious ones (trust scripts over guesses)
- How to run a single test or focused verification step
- Required command order when it matters (e.g. \`generate -> build -> test\`)
- Monorepo or multi-package boundaries and real app entrypoints
- Toolchain quirks: generated code, migrations, build artifacts, special env loading, dev servers
- Testing quirks: fixtures, required services, flaky or expensive suites
- Important constraints from existing instruction files worth preserving

Good \`STRATUM.md\` content is usually hard-earned context that took reading multiple files to infer.

## Writing rules

Include only high-signal, repo-specific guidance:
- Exact commands and shortcuts the agent would otherwise guess wrong
- Architecture notes not obvious from filenames
- Conventions that differ from language or framework defaults
- Setup requirements, environment quirks, operational gotchas

Exclude generic software advice, obvious language conventions, speculative claims, or anything you could not verify from the files you read.

When in doubt, omit. Prefer short sections and bullets. If the repo is simple, keep the file short.

If \`STRATUM.md\` already exists at \`\${path}\`, read it first and improve it in place. Preserve verified useful guidance, delete fluff or stale claims, and reconcile with the current codebase.

## Output

Write the complete \`STRATUM.md\` using the \`write_file\` tool at path \`\${path}/STRATUM.md\`. Start with a top-level \`#\` heading and use \`##\` sections for each topic. No preamble or explanation — just write the file.`;
