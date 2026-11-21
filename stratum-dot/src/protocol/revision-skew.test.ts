import { describe, expect, it } from 'vitest';
import { STRATUM_PROTOCOL_REVISION } from './index';
import { revisionSkewNotice } from './revision-skew';

describe('revisionSkewNotice', () => {
  it('sin desfase no hay aviso', () => {
    expect(revisionSkewNotice(STRATUM_PROTOCOL_REVISION, '0.15.0')).toBeNull();
  });

  it('un daemon con revisión menor es más viejo', () => {
    const notice = revisionSkewNotice(STRATUM_PROTOCOL_REVISION - 1, '0.14.0');
    expect(notice?.kind).toBe('server-older');
    expect(notice?.title).toBe('The Stratum daemon is older than this Dot');
    expect(notice?.body).toContain('It runs Stratum 0.14.0');
    expect(notice?.body).toContain('stratum daemon stop, then stratum daemon start');
  });

  it('sin revisión (daemon anterior a anunciarla) cuenta como más viejo, null o undefined', () => {
    expect(revisionSkewNotice(null, '0.14.0')?.kind).toBe('server-older');
    expect(revisionSkewNotice(undefined, '0.14.0')?.kind).toBe('server-older');
  });

  it('un daemon con revisión mayor es más nuevo que este Dot', () => {
    const notice = revisionSkewNotice(STRATUM_PROTOCOL_REVISION + 1, '0.16.0');
    expect(notice?.kind).toBe('server-newer');
    expect(notice?.title).toBe('This Dot is older than the Stratum daemon');
    expect(notice?.body).toContain('The daemon runs Stratum 0.16.0');
  });
});
