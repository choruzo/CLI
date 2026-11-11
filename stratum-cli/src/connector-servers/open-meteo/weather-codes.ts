/** Códigos WMO de Open-Meteo (`weather_code`) a texto en español. */
const WMO: Record<number, string> = {
  0: 'despejado',
  1: 'mayormente despejado',
  2: 'parcialmente nuboso',
  3: 'cubierto',
  45: 'niebla',
  48: 'niebla con escarcha',
  51: 'llovizna ligera',
  53: 'llovizna',
  55: 'llovizna intensa',
  56: 'llovizna helada',
  57: 'llovizna helada',
  61: 'lluvia ligera',
  63: 'lluvia',
  65: 'lluvia intensa',
  66: 'lluvia helada',
  67: 'lluvia helada',
  71: 'nieve ligera',
  73: 'nieve',
  75: 'nieve intensa',
  77: 'granos de nieve',
  80: 'chubascos ligeros',
  81: 'chubascos',
  82: 'chubascos fuertes',
  85: 'chubascos de nieve ligeros',
  86: 'chubascos de nieve',
  95: 'tormenta',
  96: 'tormenta con granizo',
  99: 'tormenta con granizo fuerte',
};

export function weatherText(code: number | null): string {
  if (code === null) return 'sin dato';
  return WMO[code] ?? `código meteorológico ${code}`;
}
