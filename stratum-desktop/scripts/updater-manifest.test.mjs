import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, readPackages } from './updater-manifest.mjs';

const BASE = 'https://github.com/choruzo/CLI/releases/download/desktop-v0.2.0';

describe('updater-manifest (D7)', () => {
  it('reparte los paquetes por plataforma e instalador', () => {
    const m = buildManifest(
      [
        { name: 'Stratum_0.2.0_x64-setup.exe', signature: 'SIG-NSIS\n' },
        { name: 'Stratum_0.2.0_x64_es-ES.msi', signature: 'SIG-MSI' },
        { name: 'Stratum_0.2.0_amd64.AppImage', signature: 'SIG-APPIMAGE' },
        { name: 'Stratum_0.2.0_amd64.deb', signature: 'SIG-DEB' },
        { name: 'SHA256SUMS.txt', signature: 'x' },
      ],
      { version: '0.2.0', baseUrl: `${BASE}/`, notes: 'Novedades', pubDate: '2026-09-25T10:00:00Z' },
    );
    expect(m.version).toBe('0.2.0');
    expect(m.pub_date).toBe('2026-09-25T10:00:00Z');
    expect(Object.keys(m.platforms).sort()).toEqual([
      'linux-x86_64',
      'linux-x86_64-appimage',
      'linux-x86_64-deb',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ]);
    expect(m.platforms['windows-x86_64']).toEqual({
      signature: 'SIG-NSIS',
      url: `${BASE}/Stratum_0.2.0_x64-setup.exe`,
    });
    expect(m.platforms['windows-x86_64-msi'].url).toBe(`${BASE}/Stratum_0.2.0_x64_es-ES.msi`);
    expect(m.platforms['linux-x86_64'].signature).toBe('SIG-APPIMAGE');
  });

  it('sin paquetes firmados o con versión rara, falla en vez de publicar algo vacío', () => {
    expect(() => buildManifest([], { version: '0.2.0', baseUrl: BASE })).toThrow(/Ningún paquete/);
    expect(() =>
      buildManifest([{ name: 'Stratum_0.2.0_amd64.AppImage', signature: 's' }], {
        version: 'v0.2',
        baseUrl: BASE,
      }),
    ).toThrow(/Versión/);
  });

  it('readPackages toma un paquete por firma, esté o no el binario', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-manifest-'));
    try {
      writeFileSync(join(dir, 'Stratum_0.2.0_amd64.AppImage'), 'bin');
      writeFileSync(join(dir, 'Stratum_0.2.0_amd64.AppImage.sig'), 'FIRMA');
      writeFileSync(join(dir, 'Stratum_0.2.0_amd64.deb'), 'bin');
      writeFileSync(join(dir, 'Stratum_0.2.0_x64-setup.exe.sig'), 'OTRA');
      expect(readPackages(dir).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'Stratum_0.2.0_amd64.AppImage', signature: 'FIRMA' },
        { name: 'Stratum_0.2.0_x64-setup.exe', signature: 'OTRA' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
