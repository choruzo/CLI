/**
 * M25 (voz) — el modelo de reconocimiento del habla: Canary-1B-v2 en la
 * exportación ONNX de `istupakov/canary-1b-v2-onnx`, fp32.
 *
 * Módulo **puro** (sin imports): solo constantes. Las sumas y los tamaños están
 * fijados aquí, medidos y comprobados contra Hugging Face en la fase 1 de M25
 * (`docs/PRD_STRATUM_DOT.md`, «M25 — Voz»). Si una suma no coincide, el modelo
 * no se carga: nunca se acepta un fichero a medias.
 *
 * La revisión va fijada (no `main`): un repo que cambie de contenido bajo los
 * mismos nombres dejaría el modelo descargado sin validar.
 */

export const VOICE_MODEL_ID = 'canary-1b-v2';

/** Un fichero del modelo: su nombre en el directorio, su tamaño, su suma y de dónde sale. */
export interface VoiceModelFile {
  /** Ruta relativa dentro del directorio del modelo (`~/.stratum/models/canary-1b-v2/`). */
  path: string;
  size: number;
  sha256: string;
  url: string;
}

const CANARY_REPO = 'istupakov/canary-1b-v2-onnx';
const CANARY_REVISION = '5ebc1520cef7b6b318b3526ad17adbfe00bc1bfc';

/**
 * `nemo128.onnx` **no está** en el repo de Canary: `onnx-asr` lo genera al
 * construir su paquete (`preprocessors/build.py` → `NemoPreprocessor128`) y el
 * mismo fichero, byte a byte, está publicado en el repo de Parakeet TDT v3.
 * Es el preprocesador con el que se midió todo en la fase 1. Saca 128 bandas,
 * pero **no** se afirma que equivalga al de NeMo.
 */
const PARAKEET_REPO = 'istupakov/parakeet-tdt-0.6b-v3-onnx';
const PARAKEET_REVISION = '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce';

const hfUrl = (repo: string, revision: string, path: string): string =>
  `https://huggingface.co/${repo}/resolve/${revision}/${path}`;

/** Los seis ficheros del modelo, con los valores medidos en la fase 1. */
export const VOICE_MODEL_FILES: readonly VoiceModelFile[] = [
  {
    path: 'encoder-model.onnx',
    size: 4_762_393,
    sha256: 'c8352f7adf033ad4dfcdc42e665eaacb1ee93e1acf6b168e4f1dfc57c26b0195',
    url: hfUrl(CANARY_REPO, CANARY_REVISION, 'encoder-model.onnx'),
  },
  {
    path: 'encoder-model.onnx.data',
    size: 3_284_660_224,
    sha256: 'a1711a0b88dc1bda0ff94178f2f8c66b1450990599856982ddc8cc6e155384ec',
    url: hfUrl(CANARY_REPO, CANARY_REVISION, 'encoder-model.onnx.data'),
  },
  {
    path: 'decoder-model.onnx',
    size: 676_284_211,
    sha256: '962dc77709f31c1ed8a55a7518ff4bed7316a87c442e7c79aa3573c4bbc39a72',
    url: hfUrl(CANARY_REPO, CANARY_REVISION, 'decoder-model.onnx'),
  },
  {
    path: 'vocab.txt',
    size: 208_022,
    sha256: '2c9efe6104fd29522ea27ce0e3aef5d37c690af4e5a4232e643e23ca403ffea3',
    url: hfUrl(CANARY_REPO, CANARY_REVISION, 'vocab.txt'),
  },
  {
    path: 'config.json',
    size: 68,
    sha256: 'f90ace8e35326dcd47c7330b230644fa0835083ed1e89e2f59aa08ba10d74f54',
    url: hfUrl(CANARY_REPO, CANARY_REVISION, 'config.json'),
  },
  {
    path: 'nemo128.onnx',
    size: 139_764,
    sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f',
    url: hfUrl(PARAKEET_REPO, PARAKEET_REVISION, 'nemo128.onnx'),
  },
];

/** Bytes que suman todos los ficheros (3 966 054 682). Los usa el chequeo de espacio. */
export const VOICE_MODEL_TOTAL_BYTES = VOICE_MODEL_FILES.reduce((sum, f) => sum + f.size, 0);

/**
 * Los idiomas de Canary-1B-v2. El idioma sale de la config (`voice.language`) y
 * **nunca se detecta solo**: con el idioma fijado, el modelo no traduce lo que
 * oye al inglés cuando hay ruido de fondo (fase 1).
 */
export const CANARY_LANGUAGES = [
  'bg',
  'hr',
  'cs',
  'da',
  'nl',
  'en',
  'et',
  'fi',
  'fr',
  'de',
  'el',
  'hu',
  'it',
  'lv',
  'lt',
  'mt',
  'pl',
  'pt',
  'ro',
  'sk',
  'sl',
  'es',
  'sv',
  'ru',
  'uk',
] as const;

export type CanaryLanguage = (typeof CANARY_LANGUAGES)[number];

/** ¿Es un idioma de los que Canary-1B-v2 sabe hablar? */
export function isCanaryLanguage(value: string): value is CanaryLanguage {
  return (CANARY_LANGUAGES as readonly string[]).includes(value);
}
