---
name: connector-aemet
description: Úsala cuando te pregunten por el tiempo en España (temperatura, lluvia, viento, previsión de hoy o de los próximos días, hora a hora) o por los avisos meteorológicos oficiales de una zona o provincia.
presets: [companion]
---

# AEMET: el tiempo y los avisos oficiales de España

Cuatro tools del conector AEMET (sin cuenta ni clave), todas de solo lectura, con los datos abiertos de
la Agencia Estatal de Meteorología. Devuelven texto ya resumido y en hora de Madrid.

- `aemet_municipios`: municipio por nombre o código INE, con su provincia.
- `aemet_prevision`: previsión por días (1 a 7), con cielo, temperaturas, lluvia y viento.
- `aemet_por_horas`: previsión hora a hora desde ahora (6 a 48 horas), con orto y ocaso.
- `aemet_avisos`: avisos Meteoalerta **activos** y **previstos** de un municipio, de una provincia o de toda España.

## Qué preguntas cubre

- «¿Qué tiempo hace mañana en Getafe?» → `aemet_prevision` con `dias: 2`.
- «¿Va a llover esta tarde en Foz?» → `aemet_por_horas` con `horas: 12`.
- «¿Hay alerta por viento en A Coruña?» → `aemet_avisos` con `provincia: "A Coruña"`.
- «¿Qué tiempo hará el fin de semana?» → `aemet_prevision` con `dias` de 5 a 7.

## AEMET u Open-Meteo

Las dos dan tiempo: usa **AEMET** para España, por ser la fuente oficial, y **siempre** que pregunten por
avisos o alertas (Open-Meteo no los tiene). Usa **Open-Meteo** para lugares fuera de España o cuando
AEMET no responda. No mezcles datos de las dos en una misma respuesta.

## Cómo encadenarlas

1. Pasa el nombre del municipio tal cual en `municipio` (sin acentos ni mayúsculas) o su código INE.
2. Si el nombre es ambiguo (hay varios con el mismo nombre en provincias distintas) la tool **no adivina**:
   devuelve los candidatos con provincia y código. Elige por el contexto que ya tengas o pregunta, y
   repite con el código. `aemet_municipios` sirve para lo mismo de antemano.
3. Si la tool dice «No encuentro … ¿Quizá …?» es una **aproximación** por parecido, no una coincidencia:
   confírmalo con la persona y repite con el código INE.
4. Para una provincia, `aemet_avisos` acepta su nombre («A Coruña», «Lugo») o su código de 2 dígitos («15»).
5. `aemet_avisos` separa los **activos** (ya en vigor) de los **previstos** (aún no empiezan): di cuáles son
   cuáles y no anuncies como activo un aviso previsto.
6. «¿Qué tiempo hace ahora?» → `aemet_por_horas` con `horas: 6`; no hay tool de observación actual.

## Límites

- Solo España. Fuera, di que no llega y ofrece Open-Meteo.
- Previsión de 7 días como máximo y 48 horas por horas; más allá no hay datos fiables.
- **Municipios sin previsión**: unos pocos (segregados recientes, como Fuente Carreteros) no tienen
  previsión propia. La tool lo dice y, si sabe de qué municipio se segregaron, ofrece la de ese otro:
  es **de otro municipio**, no suya; dilo así.
- Un valor «sin dato» es que AEMET no lo publica; nunca lo conviertas en 0 (un 0 de AEMET sí es un 0).
  «Precipitación inapreciable» es que llueve tan poco que no da litros: ni 0 ni «sin dato».
- No hay históricos (qué tiempo hizo el año pasado) ni datos de mar, nieve o polen.

## Atribución

Cita siempre «Fuente: AEMET» al dar los datos, también si vienen de un municipio vecino, y no insinúes que
AEMET respalde este servicio. Resume con tus palabras: no pegues la lista entera si preguntaron algo concreto.
