import { describe, expect, it } from 'vitest';
import { STRATUM_PROTOCOL_REVISION } from './index';
import { revisionSkewNotice } from './revision-skew';

describe('revisionSkewNotice', () => {
  it('sin desfase no hay aviso', () => {
    expect(revisionSkewNotice(STRATUM_PROTOCOL_REVISION, '0.15.0')).toBeNull();
  });

  it('un daemon con revisión menor es más viejo, y sin revisión también', () => {
    const notice = revisionSkewNotice(STRATUM_PROTOCOL_REVISION - 1, '0.14.0');
    expect(notice?.kind).toBe('server-older');
    expect(notice?.body).toContain('Corre Stratum 0.14.0');
    expect(notice?.body).toContain('stratum daemon stop y luego stratum daemon start');
    expect(revisionSkewNotice(null, '0.14.0')?.kind).toBe('server-older');
    expect(revisionSkewNotice(undefined, '0.14.0')?.kind).toBe('server-older');
  });

  it('un daemon con revisión mayor es más nuevo que este Desktop', () => {
    const notice = revisionSkewNotice(STRATUM_PROTOCOL_REVISION + 1, '0.16.0');
    expect(notice?.kind).toBe('server-newer');
    expect(notice?.body).toContain('El daemon corre Stratum 0.16.0');
  });
});
