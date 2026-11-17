/**
 * Genera `src/connector-servers/aemet/municipios.json`, la tabla de municipios
 * del conector AEMET: cruza el maestro de municipios de AEMET OpenData con el
 * diccionario oficial de municipios del INE. La lógica pura del cruce vive en
 * `src/connector-servers/aemet/municipios-build.ts`; aquí solo hay E/S.
 *
 *   npx tsx scripts/aemet-municipios.ts --ine <dic26.xlsx> [--maestro <maestro.json>] [--out <ruta>]
 *
 * `--ine` es el xlsx del diccionario de municipios del INE (hoja única: fila 1
 * título, fila 2 la cabecera CODAUTO/CPRO/CMUN/DC/NOMBRE, datos desde la 3).
 * Se lee como zip con el lector propio del conector Renfe y las hojas se
 * parsean con expresiones regulares. Sin `--maestro`, el maestro se descarga
 * de la API de AEMET con la cabecera `api_key: AEMET_API_KEY`; la clave nunca
 * se imprime ni se escribe. El maestro viene en ISO-8859-15 y se decodifica
 * como latin1.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildMunicipios, type IneMunicipio, type MaestroMunicipio, type Override } from '../src/connector-servers/aemet/municipios-build.js';
import { normalizeName } from '../src/connector-servers/renfe/normalize.js';
import { ZipArchive } from '../src/connector-servers/renfe/zip.js';

const MAESTRO_URL = 'https://opendata.aemet.es/opendata/api/maestro/municipios';

/** Referencia temporal del diccionario del INE usado (dic26: a 1 de enero de 2026). */
const INE_FECHA = '2026-01-01';

const SALIDA_DEFAULT = 'src/connector-servers/aemet/municipios.json';

/**
 * Municipios del INE que el maestro de AEMET aún no tiene (segregaciones y
 * fusiones recientes). Los orígenes los resuelve `buildMunicipios` buscando
 * por nombre y provincia (primero en el INE y, si ya no existe allí, en el
 * maestro); nada se escribe de memoria. Cuando AEMET incorpore un municipio,
 * el script avisa de que su override puede retirarse.
 */
const OVERRIDES: Override[] = [
  { code: '04904', origin: { name: 'Berja', province: '04' }, forecast: true }, // Balanegra (Almería)
  { code: '11903', origin: { name: 'Jimena de la Frontera', province: '11' }, forecast: false }, // San Martín del Tesorillo (Cádiz)
  { code: '14901', origin: { name: 'Fuente Palmera', province: '14' }, forecast: false }, // Fuente Carreteros (Córdoba)
  { code: '14902', origin: { name: 'Santaella', province: '14' }, forecast: false }, // La Guijarrosa (Córdoba)
  { code: '18077', origin: { name: 'Arenas del Rey', province: '18' }, forecast: false }, // Fornes (Granada)
  { code: '18106', origin: { name: 'Arenas del Rey', province: '18' }, forecast: true }, // Játar (Granada)
  { code: '18915', origin: { name: 'Iznalloz', province: '18' }, forecast: true }, // Domingo Pérez de Granada
  { code: '18916', origin: { name: 'Motril', province: '18' }, forecast: true }, // Torrenueva Costa (Granada)
  { code: '21902', origin: { name: 'Calañas', province: '21' }, forecast: false }, // La Zarza-Perrunal (Huelva)
  { code: '36902', origin: { name: 'Cerdedo', province: '36' }, forecast: true }, // Cerdedo-Cotobade (Pontevedra)
  { code: '41904', origin: { name: 'Utrera', province: '41' }, forecast: false }, // El Palmar de Troya (Sevilla)
  { code: '48916', origin: { name: 'Galdakao', province: '48' }, forecast: false }, // Usansolo (Vizcaya)
];

/** Códigos del maestro que la fusión dejó sin municipio propio en el INE; quedan como aliases de Cerdedo-Cotobade (36902). */
const ALIAS_FROM: Record<string, string> = { '36011': '36902', '36012': '36902' };

function fail(mensaje: string): never {
  throw new Error(mensaje);
}

function parseArgs(argv: string[]): { maestro?: string; ine: string; out: string } {
  let maestro: string | undefined;
  let ine: string | undefined;
  let out = SALIDA_DEFAULT;
  let i = 0;
  const ruta = (flag: string): string => {
    const v = argv[++i];
    if (!v) fail(`El flag ${flag} requiere una ruta`);
    return v;
  };
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '--maestro') maestro = ruta(a);
    else if (a === '--ine') ine = ruta(a);
    else if (a === '--out') out = ruta(a);
    else fail(`Argumento no reconocido «${a}»; uso: npx tsx scripts/aemet-municipios.ts --ine <xlsx> [--maestro <json>] [--out <ruta>]`);
    i++;
  }
  if (!ine) fail('Falta --ine <ruta del xlsx del diccionario del INE>');
  return { maestro, ine, out };
}

/** Maestro de AEMET desde la API: `{estado, datos}` → GET de la URL de datos (latin1). La clave solo viaja en la cabecera. */
async function descargarMaestro(): Promise<string> {
  const apiKey = process.env.AEMET_API_KEY;
  if (!apiKey) fail('Falta AEMET_API_KEY para descargar el maestro (o pasa --maestro <ruta>)');
  const meta = await fetch(MAESTRO_URL, { headers: { api_key: apiKey } });
  if (!meta.ok) fail(`La API de AEMET respondió ${meta.status} ${meta.statusText} al pedir el maestro`);
  const metaJson = (await meta.json()) as { estado?: number; descripcion?: string; datos?: string };
  if (metaJson.estado !== 200 || !metaJson.datos) {
    fail(`La API de AEMET no trae la URL de datos (estado ${metaJson.estado ?? 'desconocido'}${metaJson.descripcion ? `: ${metaJson.descripcion}` : ''})`);
  }
  const res = await fetch(metaJson.datos!);
  if (!res.ok) fail(`La descarga del maestro respondió ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer()).toString('latin1');
}

function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Índice de textos de `xl/sharedStrings.xml` (los `<si>` con runs se concatenan). */
function leerSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) {
    const texto = [...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join('');
    out.push(texto);
  }
  return out;
}

/** Las celdas de una fila: letra de columna → texto (shared string, número o inline). */
function leerCeldas(fila: string, cadenas: string[]): Map<string, string> {
  const celdas = new Map<string, string>();
  for (const c of fila.matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = c[1]!;
    const inner = c[2] ?? '';
    const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
    if (!ref) continue;
    const tipo = /\bt="([^"]+)"/.exec(attrs)?.[1];
    const valor = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    let texto = '';
    if (tipo === 's') texto = valor === undefined ? '' : (cadenas[Number(valor)] ?? '');
    else if (tipo === 'inlineStr') texto = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join('');
    else texto = valor === undefined ? '' : decodeXml(valor);
    celdas.set(ref[1]!, texto);
  }
  return celdas;
}

/** Lista de municipios del INE desde el xlsx (zip → sheet1.xml). */
async function leerIne(ruta: string): Promise<IneMunicipio[]> {
  const zip = await ZipArchive.open(ruta);
  const sharedXml = await zip.readText('xl/sharedStrings.xml');
  const sheetXml = await zip.readText('xl/worksheets/sheet1.xml');
  if (!sharedXml || !sheetXml) fail('El xlsx del INE no trae xl/sharedStrings.xml o xl/worksheets/sheet1.xml');
  const cadenas = leerSharedStrings(sharedXml);

  const filas = new Map<number, Map<string, string>>();
  for (const r of sheetXml.matchAll(/<row\s[^>]*>([\s\S]*?)<\/row>/g)) {
    const num = Number(/\br="(\d+)"/.exec(r[0]!)?.[1] ?? 0);
    if (num >= 1) filas.set(num, leerCeldas(r[1]!, cadenas));
  }
  const cabecera = filas.get(2);
  if (!cabecera) fail('El xlsx del INE no trae la fila de cabecera (fila 2)');
  const esperada = ['CODAUTO', 'CPRO', 'CMUN', 'DC', 'NOMBRE'];
  const letras = ['A', 'B', 'C', 'D', 'E'];
  const actual = letras.map((l) => (cabecera.get(l) ?? '').trim().toUpperCase());
  if (actual.join(',') !== esperada.join(',')) {
    fail(`La cabecera del xlsx del INE es ${actual.join(', ')} y se esperaba ${esperada.join(', ')}`);
  }

  const municipios: IneMunicipio[] = [];
  for (const num of [...filas.keys()].sort((a, b) => a - b)) {
    if (num < 3) continue; // fila 1: título; fila 2: cabecera
    const celdas = filas.get(num)!;
    const cpro = (celdas.get('B') ?? '').trim();
    const cmun = (celdas.get('C') ?? '').trim();
    const nombre = (celdas.get('E') ?? '').trim();
    if (!cpro || !cmun || !nombre) fail(`La fila ${num} del xlsx del INE no trae CPRO/CMUN/NOMBRE`);
    const code = `${cpro.replace(/\D/g, '').padStart(2, '0')}${cmun.replace(/\D/g, '').padStart(3, '0')}`;
    if (!/^\d{5}$/.test(code)) fail(`La fila ${num} del xlsx del INE produce el código «${code}» (${nombre})`);
    municipios.push({ code, name: nombre, province: code.slice(0, 2) });
  }
  if (municipios.length === 0) fail('El xlsx del INE no trae municipios');
  return municipios;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const maestroTxt = args.maestro ? readFileSync(args.maestro).toString('latin1') : await descargarMaestro();
  const maestro = JSON.parse(maestroTxt) as MaestroMunicipio[];
  if (!Array.isArray(maestro)) fail('El maestro de AEMET no es un array de municipios');

  const ine = await leerIne(args.ine);

  // Overrides que el maestro ya cubre: el build los ignora, pero conviene verlo.
  for (const o of OVERRIDES) {
    if (maestro.some((m) => String(m.id).toLowerCase() === `id${o.code}`)) {
      console.warn(`aviso: el maestro ya tiene el municipio ${o.code}; el override puede retirarse de la tabla`);
    }
  }

  const { municipios, aliases } = buildMunicipios(ine, maestro, OVERRIDES, ALIAS_FROM, normalizeName);
  const conPrevision = municipios.filter((f) => f[7]?.forecast === true).length;
  const sinPrevision = municipios.filter((f) => f[7]?.forecast === false).length;

  const json = JSON.stringify({ source: { ine: INE_FECHA, aemet_maestro: new Date().toISOString().slice(0, 10) }, municipios, aliases });
  const salida = resolve(args.out);
  mkdirSync(dirname(salida), { recursive: true });
  writeFileSync(salida, `${json}\n`); // LF tal cual, con \n final

  console.log(`INE ${INE_FECHA}: ${ine.length} municipios; maestro AEMET: ${maestro.length} registros`);
  console.log(`municipios: ${municipios.length} filas`);
  console.log(`overrides: ${OVERRIDES.length} en la tabla → ${conPrevision} con previsión y ${sinPrevision} sin ella`);
  console.log(`aliases: ${Object.keys(aliases).length}`);
  console.log(`salida: ${salida} (${statSync(salida).size} bytes)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
