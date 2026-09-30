import { describe, expect, it } from 'vitest';

import { countSpoofJobResults, spoofJobResultKind } from './jobTypes';

describe('job history metrics', () => {
  it('keeps uploads, downloads, skips, failures and cancellations disjoint', () => {
    const results = [
      { id: '1', success: true, newId: '101' },
      { id: '2', success: true, reason: 'downloaded', localPath: '/tmp/2.rbxm' },
      { id: '3', success: true, skipped: true, reason: 'filtered' },
      { id: '4', success: false, stage: 'upload' as const, errorReason: 'denied' },
      { id: '5', success: false, cancelled: true, reason: 'cancelled' },
    ];

    expect(results.map(spoofJobResultKind)).toEqual([
      'uploaded',
      'downloaded',
      'skipped',
      'failed',
      'cancelled',
    ]);
    expect(countSpoofJobResults(results)).toEqual({
      uploaded: 1,
      downloaded: 1,
      skipped: 1,
      failed: 1,
      cancelled: 1,
      total: 5,
    });
  });

  it('does not count a successful skip as an uploaded asset', () => {
    expect(countSpoofJobResults([{ id: '507766951', success: true, skipped: true }])).toEqual({
      uploaded: 0,
      downloaded: 0,
      skipped: 1,
      failed: 0,
      cancelled: 0,
      total: 1,
    });
  });
});
