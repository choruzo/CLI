# web_search — Especificación de mejoras

> Documento de diseño. Motivado por análisis del proyecto [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus)
> (MIT), en particular `services/search/ranking.py` y `services/search/providers.py`.

---

## Estado actual

`tools/web/search.ts` implementa:

- **Backends:** DuckDuckGo (scraping HTML) + Tavily (API, opcional).
- **Merge:** Reciprocal Rank Fusion (RRF) entre las dos listas — `score = Σ 1/(k + rank)`.
- **Dedup:** normalización de URL (sin tracking params, sin `www.`, sin trailing slash).
- **Config (`tools.webSearch`):** `backend` | `tavilyApiKey` | `maxResults`.

### Limitaciones identificadas

1. El RRF solo ordena por *posición relativa entre motores*, no evalúa calidad intrínseca del resultado.
2. No hay penalización por dominio de baja calidad ni bonificación por fuentes autoritativas.
3. No hay scoring de recencia — un resultado de 2019 compite en igualdad con uno de ayer.
4. Un solo punto de fallo real: si DDG está bloqueando requests frecuentes, no hay alternativa gratuita.
5. La tool no acepta filtro temporal — el agente no puede pedir "noticias de esta semana".

---

## Alcance de las mejoras

### 1. Re-rank multi-factor (post-RRF)

El RRF se mantiene como fase de merge. Se añade una segunda pasada de scoring sobre los resultados ya fusionados, basada en cuatro factores independientes:

```
score = 2.0 × title_score
      + 1.0 × snippet_score
      + 1.5 × domain_score
      + 1.0 × recency_score
      ±      news_adjustment   (solo si la query es de noticias)
```

#### `title_score`

Fracción de query-terms presentes en el título, usando word-boundary match (`\b`).
Evita falsos positivos de substring: "sport" en "transport" no cuenta.

```ts
function titleScore(title: string, queryTerms: string[]): number {
  if (!title || !queryTerms.length) return 0;
  const lc = title.toLowerCase();
  const matches = queryTerms.filter(t => new RegExp(`\\b${escapeRe(t)}\\b`).test(lc)).length;
  return matches / queryTerms.length;
}
```

#### `snippet_score`

Combinación de densidad de términos (0.5) y longitud normalizada a 200 chars (0.5).
Un snippet vacío da 0; uno largo y relevante da 1.

```ts
function snippetScore(snippet: string, queryTerms: string[]): number {
  if (!snippet) return 0;
  const lengthFactor = Math.min(snippet.length, 200) / 200;
  const lc = snippet.toLowerCase();
  const termFactor = queryTerms.filter(t => lc.includes(t)).length / (queryTerms.length || 1);
  return (lengthFactor + termFactor) / 2;
}
```

#### `domain_score`

Autoridad fija por TLD o dominio conocido. No depende de ningún servicio externo.

| Condición | Score |
|-----------|-------|
| Dominio en lista `TRUSTED_DOMAINS` (ver abajo) | 1.0 |
| TLD `.edu` o `.gov` | 1.0 |
| TLD `.org` | 0.7 |
| Resto | 0.4 |

Lista inicial de `TRUSTED_DOMAINS`:
`apnews.com`, `reuters.com`, `bbc.com`, `theguardian.com`, `nature.com`,
`ncbi.nlm.nih.gov`, `github.com`, `stackoverflow.com`, `developer.mozilla.org`,
`docs.python.org`, `arxiv.org`, `wikipedia.org`.

La lista debe ser configurable vía `tools.webSearch.trustedDomains` (se fusiona con la lista base, no la reemplaza).

#### `recency_score`

Solo aplica si el resultado incluye campo `age` (fecha ISO). Los backends que devuelven fecha son Tavily y Brave; DDG no la incluye — esos resultados reciben `0` en este factor (neutro, no penalización).

```
age <= 7 días  → 1.0
age >= 30 días → 0.0
entre ambos    → lineal: (30 - days) / 23
```

#### `news_adjustment`

Si la query contiene términos como `news`, `latest`, `today`, `breaking`, `headlines`:

- Dominio en `TRUSTED_DOMAINS` news tier (AP, Reuters, BBC…) → `+1.2`
- Dominio en lista `LOW_VALUE_NEWS` (facebook.com, msn.com, yahoo.com) → `−0.8`
- Query no es sobre deportes y el snippet/título sí lo es → `−1.5` (evita contaminación cruzada)

---

### 2. Nuevos providers

#### SearXNG (self-hosted, sin API key)

**Motivación:** usuarios con infraestructura propia (Ollama, vLLM, etc.) pueden levantar una instancia SearXNG en Docker junto al resto del stack. Sin dependencia de terceros, sin rate limiting externo.

```bash
docker run -d --name searxng -p 8080:8080 searxng/searxng
```

Configuración en `.stratumrc.json`:
```json
"tools": {
  "webSearch": {
    "backend": "meta",
    "searxngUrl": "http://localhost:8080"
  }
}
```

La tool llama a `GET /search?q=<query>&format=json&language=en` y parsea `results[].{title, url, content}`.
Si `searxngUrl` está configurado, SearXNG entra en la pool de meta-búsqueda junto a DDG.
Si `backend` es `"searxng"`, se usa solo SearXNG.

Fallback: si la respuesta JSON falla (SearXNG en config sin `format=json` habilitado), reintentar parseando HTML (`article.result h3 a`, `p.content`).

#### Brave Search (API, capa gratuita 2000 req/mes)

```json
"tools": {
  "webSearch": {
    "braveApiKey": "BSA..."
  }
}
```

Endpoint: `GET https://api.search.brave.com/res/v1/web/search`
Headers: `X-Subscription-Token: <key>`
Devuelve `age` (fecha) → alimenta el `recency_score`.

Si `braveApiKey` está presente, Brave entra en la pool de meta-búsqueda o se puede forzar con `backend: "brave"`.

---

### 3. Parámetro `time_filter`

Nuevo parámetro opcional en el schema de la tool:

```ts
time_filter: z.enum(['day', 'week', 'month', 'year']).optional()
  .describe('Restrict results to a time window. Supported by Tavily and Brave.')
```

Traducción por backend:

| Backend | Parámetro | Valores |
|---------|-----------|---------|
| Tavily | `days` | 1 / 7 / 30 / 365 |
| Brave | `freshness` | `day` / `week` / `month` / `year` |
| SearXNG | `time_range` | `day` → `week` (SearXNG news, no hay granularidad diaria) |
| DDG | — | no soportado, se ignora silenciosamente |

---

## Cambios de schema (`.stratumrc.json`)

```ts
webSearch: z.object({
  backend: z.enum([
    'meta',        // DDG + Tavily + SearXNG (si configurado) + Brave (si configurado)
    'duckduckgo',
    'tavily',
    'searxng',
    'brave',
  ]).default('meta'),

  tavilyApiKey:   z.string().default(''),
  braveApiKey:    z.string().default(''),
  searxngUrl:     z.string().url().optional(),

  maxResults:     z.number().int().positive().max(20).default(10),

  // Dominios adicionales que reciben domain_score = 1.0
  // Se fusionan con la lista base, no la reemplazan
  trustedDomains: z.array(z.string()).default([]),
})
```

`apiKey` (campo legacy) se mantiene como alias de `tavilyApiKey` por compatibilidad hacia atrás.

---

## Plan de implementación

### Fase 1 — Re-rank (sin breaking changes)

Archivos afectados: solo `tools/web/search.ts`.

1. Extraer `queryTerms` de la query (tokenizar, lowercase, filtrar stopwords triviales).
2. Ampliar `SearchResult` con campo opcional `age?: string`.
3. Hacer que `searchTavily` y (futuro) `searchBrave` mapeen `published_date` / `date` → `age`.
4. Implementar `rankResults(results, query)` que aplica el scoring descrito y devuelve la lista re-ordenada.
5. Insertar `rankResults` después de `mergeResults` en `execute()`.
6. Tests unitarios en `search.test.ts`: ranking por título, por dominio, por recencia, ajuste de noticias.

### Fase 2 — SearXNG + Brave

1. Implementar `searchSearXNG(query, url, maxResults, timeFilter, signal)`.
2. Implementar `searchBrave(query, apiKey, maxResults, timeFilter, signal)`.
3. Actualizar el bloque de construcción de `tasks[]` en `execute()` para incluirlos según config.
4. Actualizar el enum `backend` en `schema.ts`.
5. Actualizar la descripción de la tool para reflejar los nuevos backends.

### Fase 3 — `time_filter`

1. Añadir `time_filter` al schema Zod de la tool.
2. Propagarlo a cada función de backend.
3. Documentar en la descripción de la tool que DDG no lo soporta.

---

## No incluido en este scope

- **Serper.dev / Google PSE** — de pago, baja prioridad frente a Brave (capa gratuita).
- **SafeSearch configurable** — no relevante para uso CLI de agente.
- **Caché de resultados** — relevante pero es un módulo transversal (afecta a todos los tools de red), se trata por separado.
- **SearXNG image/news category toggle** — la tool es de propósito general; categorías especializadas se pueden manejar con `time_filter` + query semántica.
