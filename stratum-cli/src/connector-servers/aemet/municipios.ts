/**
 * Índice de búsqueda de municipios sobre `municipios.json` (la tabla que genera
 * `scripts/aemet-municipios.ts`, importada como JSON: esbuild/tsup la empaqueta
 * dentro del `.mjs` del conector). Busca por nombre sin acentos ni mayúsculas
 * (INE, visible y aliases), y acepta el código INE de 5 dígitos. Con varios
 * candidatos los devuelve todos con provincia y código, sin adivinar: primero
 * la coincidencia exacta, luego por prefijo y, al final, por similitud; en
 * empate, primero los más poblados (`null` al final).
 *
 * La similitud es la última red y es deliberadamente estrecha (distancia ≤ 1
 * hasta 6 letras y ≤ 2 a partir de 7, como mucho `MAX_SIMILITUD` resultados):
 * sus candidatos son una **aproximación** (nivel `2`), nunca una coincidencia, y
 * quien la enseñe tiene que pedir el código INE en vez de quedarse con uno.
 */
import municipiosJson from './municipios.json' with { type: 'json' };
import { normalizeName } from '../renfe/normalize.js';
import type { Row, RowFlags } from './municipios-build.js';
import { provinciaNombre } from './provincias.js';

/** Municipio de la tabla, tal cual `municipios-build.ts` la construye. */
export interface Municipio {
  code: string;
  /** Nombre oficial del INE («Acebeda, La»). */
  name: string;
  /** Forma visible («La Acebeda»). */
  visible: string;
  /** Zona de avisos Meteoalerta (6 dígitos). */
  zona: string;
  lat: number;
  lon: number;
  /** Habitantes según el maestro de AEMET; `null` si aún no los tiene. */
  hab: number | null;
  province: string;
  provincia: string;
  /**
   * Solo en los municipios del INE que el maestro de AEMET aún no tiene: si
   * su previsión es la del origen de la zona (`forecast: true`, con `from`) o si
   * no tiene previsión y solo vale la del vecino más cercano
   * (`forecast: false`, con `nearest`).
   */
  flags?: RowFlags;
}

export interface MunicipioConPuntos extends Municipio {
  /** `0` exacta, `1` por prefijo, `2` por similitud; los de menor nivel ganan. */
  nivel: number;
}

interface FilaTabla {
  code: string;
  name: string;
  visible: string;
  zona: string;
  lat: number;
  lon: number;
  hab: number | null;
  province: string;
  provincia: string;
  norm: string;
  normVisible: string;
  flags?: RowFlags;
}

const TABLA: FilaTabla[] = (municipiosJson.municipios as unknown as Row[]).map(
  ([code, name, visible, zona, lat, lon, hab, flags]): FilaTabla => ({
    code,
    name,
    visible,
    zona,
    lat,
    lon,
    hab,
    province: code.slice(0, 2),
    provincia: provinciaNombre(code.slice(0, 2)),
    norm: normalizeName(name),
    normVisible: normalizeName(visible),
    flags,
  }),
);

const POR_CODIGO = new Map(TABLA.map((m) => [m.code, m]));
const ALIAS: Record<string, string> = municipiosJson.aliases;

/** Candidatos que devuelve la búsqueda por similitud (es una aproximación, no una lista). */
export const MAX_SIMILITUD = 5;

export const TOTAL_MUNICIPIOS = TABLA.length;

/** Municipio por código INE de 5 dígitos. */
export function municipioPorCodigo(code: string): Municipio | undefined {
  return POR_CODIGO.get(code);
}

/**
 * Conjunto de zonas Meteoalerta de una provincia (código de 2 dígitos),
 * derivado de la tabla real. Es el criterio medido — el código de zona
 * Meteoalerta identifica la provincia en `zona[2:4]` salvo en Illes Balears
 * (todas empiezan por `645`) y Canarias (`659`, compartido por Las Palmas y
 * Santa Cruz de Tenerife), así que el filtro de avisos por provincia usa este
 * índice y no el formato del código.
 */
export function zonasPorProvincia(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of TABLA) {
    let zonas = out.get(m.province);
    if (!zonas) out.set(m.province, (zonas = new Set()));
    zonas.add(m.zona);
  }
  return out;
}

/** Distancia de edición acotada (Ventzorinsky de dos filas); `null` si pasa del límite. */
function similitud(a: string, b: string, limite: number): number | null {
  if (Math.abs(a.length - b.length) > limite) return null;
  let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(actual[j - 1]! + 1, previa[j]! + 1, previa[j - 1]! + coste);
    }
    if (Math.min(...actual) > limite) return null;
    previa = actual;
  }
  return previa[b.length]!;
}

const porPoblacion = (
  a: FilaTabla | MunicipioConPuntos,
  b: FilaTabla | MunicipioConPuntos,
): number =>
  (a.hab ?? -1) === (b.hab ?? -1) ? a.code.localeCompare(b.code) : (b.hab ?? -1) - (a.hab ?? -1);

/**
 * Busca municipios por nombre (o código INE de 5 dígitos). Devuelve todos los
 * candidatos ordenados: coincidencia exacta primero, luego por prefijo y por
 * similitud; en empate, primero los más poblados. Sin resultados, lista vacía.
 */
export function buscarMunicipios(consulta: string): MunicipioConPuntos[] {
  const query = consulta.trim();
  const vistos = new Map<string, MunicipioConPuntos>();
  const add = (m: FilaTabla, nivel: number): void => {
    const previo = vistos.get(m.code);
    if (previo && previo.nivel <= nivel) return;
    vistos.set(m.code, {
      code: m.code,
      name: m.name,
      visible: m.visible,
      zona: m.zona,
      lat: m.lat,
      lon: m.lon,
      hab: m.hab,
      province: m.province,
      provincia: m.provincia,
      flags: m.flags,
      nivel,
    });
  };

  if (/^\d{5}$/.test(query)) {
    const m = POR_CODIGO.get(query);
    if (m) add(m, 0);
    return [...vistos.values()];
  }
  const norm = normalizeName(query);
  if (!norm) return [];

  // Exacta: por el nombre INE, por el visible y por los alias (municipios
  // desaparecidos como Cerdedo o Cotobade).
  const codigoAlias = ALIAS[norm];
  if (codigoAlias) {
    const m = POR_CODIGO.get(codigoAlias);
    if (m) add(m, 0);
  }
  for (const m of TABLA) if (m.norm === norm || m.normVisible === norm) add(m, 0);
  if (vistos.size > 0) return [...vistos.values()].sort(porPoblacion);

  // Prefijo: «geta» → Getafe; «la ace» → La Acebeda.
  for (const m of TABLA) {
    if (m.norm.startsWith(norm) || m.normVisible.startsWith(norm)) add(m, 1);
  }
  if (vistos.size > 0) return [...vistos.values()].sort(porPoblacion);

  // Similitud (erratas): umbral por longitud (1 hasta 6 letras, 2 a partir de 7) y
  // como mucho 5 candidatos. Es una **aproximación**, no una coincidencia: quien
  // la enseña tiene que decir «¿quizá…?» y pedir el código INE.
  const limite = norm.length >= 7 ? 2 : 1;
  for (const m of TABLA) {
    const d = similitud(norm, m.norm, limite) ?? similitud(norm, m.normVisible, limite);
    if (d !== null) add(m, 2);
  }
  return [...vistos.values()].sort(porPoblacion).slice(0, MAX_SIMILITUD);
}
