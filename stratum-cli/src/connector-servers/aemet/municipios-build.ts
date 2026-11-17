/**
 * Lógica pura de la tabla de municipios del conector AEMET
 * (`municipios.json`): cruza el maestro de municipios de AEMET OpenData con el
 * diccionario oficial de municipios del INE. La lista del INE es la fuente de
 * verdad (códigos y nombres oficiales); del maestro se toman `zona_comarcal`
 * (la zona de avisos Meteoalerta), las coordenadas y los habitantes, cruzando
 * por código (`id28065` → `28065`).
 *
 * Sin E/S de ficheros ni red: el script `scripts/aemet-municipios.ts` lee las
 * entradas y llama a `buildMunicipios`, y los tests la ejercitan con datos
 * sintéticos. Solo importa lo permitido a `src/connector-servers/` (lo vigila
 * `architecture.test.ts`): relativos dentro de la carpeta, `node:*` y `zod`.
 */

/** Municipio del diccionario del INE: código oficial de 5 dígitos, nombre oficial y provincia (el prefijo de 2 dígitos del código). */
export interface IneMunicipio {
  code: string;
  name: string;
  province: string;
}

/** Registro del maestro de municipios de AEMET OpenData, tal cual lo sirve la API (trae más campos; estos son los que se usan). */
export interface MaestroMunicipio {
  id: string;
  nombre: string;
  /** Zona de avisos Meteoalerta (6 dígitos). */
  zona_comarcal: string;
  latitud_dec: string;
  longitud_dec: string;
  num_hab: string;
}

/** Municipio al que se segrega o fusiona otro: se resuelve por nombre normalizado y provincia, primero en el INE y, si ya no existe allí, en el maestro. */
export interface NombreProvincia {
  name: string;
  /** Código de provincia INE (CPRO, 2 dígitos). */
  province: string;
}

/** Municipio del INE que el maestro de AEMET aún no tiene (segregación o fusión reciente). */
export interface Override {
  /** Código INE de 5 dígitos del municipio nuevo. */
  code: string;
  /** Municipio de origen: zona, coordenadas y habitantes se copian de él. */
  origin: NombreProvincia;
  /** ``true``: AEMET ya le da previsión con **su propio código** (la zona y las coordenadas son las del origen). `false`: sin previsión; el conector usará el origen como vecino más cercano. */
  forecast: boolean;
}

/** Flags de las filas que vienen de un `Override`: la zona y las coordenadas son las del origen (`coordsFrom`), pero **la previsión se pide con el código del municipio**, no con el del origen (medido: los cinco con `forecast: true` responden 200 en su propio `localidad_<code>.xml`). `from` solo dice de dónde salen zona y coordenadas; `nearest` es el municipio del que se segregó y cuya previsión se ofrece cuando el propio no tiene ninguna. */
export type RowFlags =
  | { forecast: true; from: string; coordsFrom: string }
  | { forecast: false; nearest: string; coordsFrom: string };

/** Fila de la tabla: código, nombre INE, nombre visible, zona, lat, lon, habitantes (null en los overrides: los del origen no son los suyos) y flags (solo en los overrides). */
export type Row = [string, string, string, string, number, number, number | null, RowFlags?];

export interface BuildResult {
  municipios: Row[];
  /** Nombre normalizado de cada municipio desaparecido (fusionado) → código del municipio nuevo. */
  aliases: Record<string, string>;
}

const ARTICULO_FINAL = /^(.+), (L'|La|El|Los|Las|Les|Els|O|A|Os|As)$/i;

/** Forma visible del nombre INE: el artículo pospuesto tras la coma pasa al principio («Acebeda, La» → «La Acebeda»); `L'` va sin espacio. */
export function displayName(ineName: string): string {
  const name = ineName.trim();
  const m = ARTICULO_FINAL.exec(name);
  if (!m) return name;
  const art = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1);
  return art === "L'" ? art + m[1]! : `${art} ${m[1]!}`;
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

const CODIGO_RE = /^\d{5}$/;
const ID_RE = /^id(\d{5})$/i;
const ZONA_RE = /^\d{6}$/;

/**
 * Cruza el INE (fuente de verdad de códigos y nombres) con el maestro de AEMET
 * (zona de avisos, coordenadas y habitantes). `overrides` explica los
 * municipios del INE que el maestro aún no tiene; `aliasFrom` mapea cada
 * código del maestro que ha desaparecido en el INE al código del municipio
 * nuevo al que queda ligado (sus nombres, normalizados con `normalize`,
 * forman las `aliases` de salida). Lanza `Error` con la lista de los códigos
 * sin explicar: del INE que el maestro no tiene y sin override, y del maestro
 * que ya no está en el INE y no es alias.
 */
export function buildMunicipios(
  ine: IneMunicipio[],
  maestro: MaestroMunicipio[],
  overrides: Override[],
  aliasFrom: Record<string, string>,
  normalize: (s: string) => string,
): BuildResult {
  const unexplained: string[] = [];
  const problems: string[] = [];

  const ineByCode = new Map<string, IneMunicipio>();
  for (const m of ine) {
    const code = String(m.code).trim();
    if (!CODIGO_RE.test(code)) {
      problems.push(`INE: código no reconocido «${code}» (${m.name})`);
      continue;
    }
    if (m.province !== code.slice(0, 2)) {
      problems.push(`INE: la provincia «${m.province}» no es el prefijo de ${code} (${m.name})`);
    }
    const previo = ineByCode.get(code);
    if (previo) {
      problems.push(`INE: código duplicado ${code} (${previo.name} / ${m.name})`);
      continue;
    }
    ineByCode.set(code, { code, name: String(m.name).trim(), province: m.province });
  }

  const maestroByCode = new Map<string, MaestroMunicipio>();
  for (const m of maestro) {
    const id = String(m.id ?? '').trim();
    const match = ID_RE.exec(id);
    if (!match) {
      problems.push(`Maestro: id no reconocido «${id}» (${m.nombre})`);
      continue;
    }
    const code = match[1]!;
    const previo = maestroByCode.get(code);
    if (previo) {
      problems.push(`Maestro: código duplicado ${code} (${previo.nombre} / ${m.nombre})`);
      continue;
    }
    maestroByCode.set(code, m);
  }

  // Origen de cada override: por nombre normalizado y provincia, primero en el
  // INE y, si el municipio ya no existe allí (fusión), en el maestro. INE y
  // maestro suelen coincidir en el mismo código: se desduplica por código.
  interface Origen {
    code: string;
    name: string;
  }
  const resolveOrigin = (o: NombreProvincia, overrideCode: string): Origen | null => {
    const norm = normalize(String(o.name));
    const candidatos = new Map<string, Origen>();
    for (const m of ineByCode.values()) {
      if (m.province === o.province && normalize(m.name) === norm) {
        candidatos.set(m.code, { code: m.code, name: m.name });
      }
    }
    for (const [code, m] of maestroByCode) {
      if (code.startsWith(o.province) && normalize(String(m.nombre)) === norm) {
        candidatos.set(code, { code, name: String(m.nombre) });
      }
    }
    if (candidatos.size === 0) {
      // Diagnóstico: ¿aparece el nombre en otra provincia?
      const enOtras = new Set<string>();
      for (const m of ineByCode.values()) {
        if (m.province !== o.province && normalize(m.name) === norm)
          enOtras.add(`${m.code} (${m.name})`);
      }
      for (const [code, m] of maestroByCode) {
        if (!code.startsWith(o.province) && normalize(String(m.nombre)) === norm)
          enOtras.add(`${code} (${m.nombre})`);
      }
      problems.push(
        enOtras.size > 0
          ? `Override de ${overrideCode}: el origen «${o.name}» no está en la provincia ${o.province}; coincide en ${[...enOtras].sort().join(', ')}`
          : `Override de ${overrideCode}: el origen «${o.name}» no está ni en el INE ni en el maestro (provincia ${o.province})`,
      );
      return null;
    }
    if (candidatos.size > 1) {
      problems.push(
        `Override de ${overrideCode}: origen «${o.name}» ambiguo en la provincia ${o.province}: ${[...candidatos.keys()].sort().join(', ')}`,
      );
      return null;
    }
    return [...candidatos.values()][0]!;
  };

  const overrideByCode = new Map<string, { forecast: boolean; origin: Origen }>();
  const overrideCodes = new Set<string>();
  for (const o of overrides) {
    const code = String(o.code).trim();
    overrideCodes.add(code);
    if (!CODIGO_RE.test(code)) {
      problems.push(`Override: código no reconocido «${code}»`);
      continue;
    }
    if (!ineByCode.has(code)) {
      problems.push(`Override: el código ${code} no está en el INE`);
      continue;
    }
    if (maestroByCode.has(code)) continue; // el maestro ya lo cubre: override obsoleto, se ignora
    const previo = overrideByCode.get(code);
    if (previo) {
      problems.push(`Override: código duplicado ${code}`);
      continue;
    }
    const origen = resolveOrigin(o.origin, code);
    if (!origen) continue;
    overrideByCode.set(code, { forecast: o.forecast === true, origin: origen });
  }

  const aliasCodes = new Set<string>();
  const aliasEntries = new Map<string, string>();
  for (const [code, target] of Object.entries(aliasFrom)) {
    aliasCodes.add(code);
    const m = maestroByCode.get(code);
    if (!m) {
      problems.push(`Alias: el código ${code} no está en el maestro`);
      continue;
    }
    const targetCode = String(target).trim();
    if (!ineByCode.has(targetCode)) {
      problems.push(`Alias: ${code} (${m.nombre}) apunta a «${targetCode}», que no está en el INE`);
      continue;
    }
    if (ineByCode.has(code)) {
      problems.push(`Alias: ${code} (${m.nombre}) sigue existiendo en el INE; el alias sobra`);
      continue;
    }
    const key = normalize(String(m.nombre));
    if (!key) {
      problems.push(`Alias: el nombre de ${code} («${m.nombre}») se queda vacío al normalizar`);
      continue;
    }
    const previo = aliasEntries.get(key);
    if (previo && previo !== targetCode) {
      problems.push(`Alias: «${key}» apunta a la vez a ${previo} y a ${targetCode}`);
      continue;
    }
    aliasEntries.set(key, targetCode);
  }

  // Zona, coordenadas y habitantes de un registro del maestro, ya validados.
  interface DatosMaestro {
    zona: string;
    lat: number;
    lon: number;
    hab: number;
  }
  const parseDatos = (code: string, nombre: string, m: MaestroMunicipio): DatosMaestro | null => {
    let ok = true;
    const zona = String(m.zona_comarcal ?? '').trim();
    if (!ZONA_RE.test(zona)) {
      problems.push(`Maestro ${code} (${nombre}): zona_comarcal «${zona}» no es de 6 dígitos`);
      ok = false;
    }
    const latTxt = String(m.latitud_dec ?? '').trim();
    const lonTxt = String(m.longitud_dec ?? '').trim();
    const lat = Number.parseFloat(latTxt);
    const lon = Number.parseFloat(lonTxt);
    if (!Number.isFinite(lat)) {
      problems.push(`Maestro ${code} (${nombre}): latitud_dec «${latTxt}» no es numérica`);
      ok = false;
    }
    if (!Number.isFinite(lon)) {
      problems.push(`Maestro ${code} (${nombre}): longitud_dec «${lonTxt}» no es numérica`);
      ok = false;
    }
    const habTxt = String(m.num_hab ?? '').trim();
    const hab = Number.parseInt(habTxt, 10);
    if (!Number.isInteger(hab)) {
      problems.push(`Maestro ${code} (${nombre}): num_hab «${habTxt}» no es un entero`);
      ok = false;
    }
    return ok ? { zona, lat, lon, hab } : null;
  };

  const fila = (
    m: IneMunicipio,
    d: DatosMaestro,
    flags?: RowFlags,
    hab: number | null = d.hab,
  ): Row => {
    const base: [string, string, string, string, number, number, number | null] = [
      m.code,
      m.name,
      displayName(m.name),
      d.zona,
      round4(d.lat),
      round4(d.lon),
      hab,
    ];
    return flags ? [...base, flags] : base;
  };

  const rows: Row[] = [];
  for (const m of ineByCode.values()) {
    const mz = maestroByCode.get(m.code);
    const datos = mz ? parseDatos(m.code, m.name, mz) : null;
    if (datos) {
      rows.push(fila(m, datos));
      continue;
    }
    const ov = overrideByCode.get(m.code);
    if (ov) {
      const om = maestroByCode.get(ov.origin.code);
      if (!om) {
        problems.push(
          `Override de ${m.code}: el origen ${ov.origin.code} (${ov.origin.name}) no tiene datos en el maestro`,
        );
      } else {
        const dOrigen = parseDatos(m.code, `${m.name} ← ${ov.origin.name}`, om);
        if (dOrigen) {
          // La zona y las coordenadas son las del origen (coordsFrom), pero los
          // habitantes no son los suyos: hasta que AEMET los publique, null.
          const flags: RowFlags = ov.forecast
            ? { forecast: true, from: ov.origin.code, coordsFrom: ov.origin.code }
            : { forecast: false, nearest: ov.origin.code, coordsFrom: ov.origin.code };
          rows.push(fila(m, dOrigen, flags, null));
        }
      }
      continue;
    }
    if (overrideCodes.has(m.code)) continue; // su override ya dejó constancia del problema
    unexplained.push(`INE ${m.code} (${m.name}): sin datos en el maestro de AEMET y sin override`);
  }

  for (const [code, m] of maestroByCode) {
    if (ineByCode.has(code)) continue;
    if (aliasCodes.has(code)) continue;
    unexplained.push(
      `Maestro ${code} (${m.nombre}): ya no está en el INE y no es alias de ninguno`,
    );
  }

  if (unexplained.length > 0 || problems.length > 0) {
    const lista = [...unexplained, ...problems].map((p) => `  - ${p}`).join('\n');
    throw new Error(
      `Tabla de municipios de AEMET: ${unexplained.length + problems.length} problema(s) por revisar:\n${lista}`,
    );
  }

  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const aliases: Record<string, string> = {};
  for (const key of [...aliasEntries.keys()].sort()) aliases[key] = aliasEntries.get(key)!;
  return { municipios: rows, aliases };
}
