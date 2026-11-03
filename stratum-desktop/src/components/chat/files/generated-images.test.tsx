import { describe, expect, it } from 'vitest';
import { imageRequest, matchCommands, parseCommand } from '../commands';
import { callImageTag, generatedImagePaths, imagesOfCall } from './GeneratedImages';
import type { ListedFile } from '../../../ipc/files';

const file = (path: string, area: ListedFile['area'] = 'outputs'): ListedFile => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  size: 1,
  area,
  modifiedMs: 0,
});

describe('/imagen', () => {
  it('pide una descripción y la convierte en un mensaje para el asistente', () => {
    expect(matchCommands('/im')?.map((c) => c.name)).toEqual(['imagen']);
    expect(parseCommand('/imagen  un zorro en la nieve ')).toEqual({
      ok: true,
      name: 'imagen',
      arg: 'un zorro en la nieve',
    });
    const empty = parseCommand('/imagen');
    expect(empty?.ok).toBe(false);
    expect(imageRequest(' un zorro ')).toBe('Genera una imagen: un zorro');
  });
});

describe('imágenes de generate_image', () => {
  it('lee las rutas del principio de la salida y nada más', () => {
    expect(
      generatedImagePaths('outputs/zorro-abc.png\noutputs/zorro-abc-2.jpg\n\nGenerated 2 image(s)'),
    ).toEqual(['outputs/zorro-abc.png', 'outputs/zorro-abc-2.jpg']);
    expect(generatedImagePaths('outputs/../secreto.png')).toEqual([]);
    expect(generatedImagePaths('inputs/foto.png')).toEqual([]);
    expect(generatedImagePaths('outputs/informe.md')).toEqual([]);
    expect(generatedImagePaths(undefined)).toEqual([]);
  });

  it('sin salida, las encuentra en outputs/ por la marca de la llamada', () => {
    expect(callImageTag('call_AbC123')).toBe('callabc123');
    const files = [
      file('outputs/gato-callabc123.png'),
      file('outputs/gato-callabc123-v2.png'),
      file('outputs/perro-callabc123-1.webp'),
      file('outputs/gato-otra.png'),
      file('outputs/notas-callabc123.md'),
      file('inputs/gato-callabc123.png', 'inputs'),
    ];
    expect(imagesOfCall(files, 'call_AbC123')).toEqual([
      'outputs/gato-callabc123-v2.png',
      'outputs/gato-callabc123.png',
      'outputs/perro-callabc123-1.webp',
    ]);
    expect(imagesOfCall(files, '___')).toEqual([]);
  });
});
