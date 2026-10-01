import { describe, expect, it } from 'vitest';

import {
  acceptsJobEvent,
  countJobResults,
  jobReplacements,
  normalizeJobResults,
  transferStage,
} from './jobProgress';

describe('job progress', () => {
  it('never substitutes older upload IDs for failed or cancelled results', () => {
    expect(
      jobReplacements(
        [
          { id: '1', success: false },
          { id: '2', success: true, cancelled: true, newId: '22' },
          { id: '3', success: true, skipped: true, newId: '33' },
          { id: '4', success: true, skipped: true },
          { id: '5', success: true, new_asset_id: '55' },
        ],
        { '1': '11', '4': '44', '6': '66' },
        ['1', '4', '6'],
      ),
    ).toEqual({ '3': '33', '5': '55' });
  });

  it('limits restored history to the assets currently loaded', () => {
    expect(jobReplacements([], { '1': '11', '2': '22', '3': 'invalid' }, ['1', '3'])).toEqual({
      '1': '11',
    });
  });
  it('ignores delayed events from a finished or different job', () => {
    expect(acceptsJobEvent('new', true, 'old')).toBe(false);
    expect(acceptsJobEvent('new', false, 'new')).toBe(false);
    expect(acceptsJobEvent('new', true, 'new')).toBe(true);
  });

  it('does not complete an asset when only its download finished', () => {
    expect(transferStage('downloading', 'job:dl:123', 'completed', 'job')).toBeNull();
    expect(transferStage('uploading', 'job:dl:123', 'downloading:90', 'job')).toBeNull();
    expect(transferStage('done', 'job:up:123', 'processing', 'job')).toBeNull();
    expect(transferStage('downloading', 'old:up:123', 'processing', 'job')).toBeNull();
  });

  it('shows recovery during download discovery and allows the recovered download to proceed', () => {
    expect(transferStage('downloading', 'job:dl:123', 'recovering', 'job')).toBe('recovering');
    expect(transferStage('discovering_graph', 'job:dl:123', 'recovering', 'job')).toBe(
      'recovering',
    );
    expect(transferStage('recovering', 'job:dl:123', 'downloading:1/4', 'job')).toBe('downloading');
    expect(transferStage('recovering', 'job:up:123', 'processing', 'job')).toBe('uploading');
  });

  it('ignores recovery events from another job or after an asset has finished', () => {
    expect(transferStage('downloading', 'job-other:dl:123', 'recovering', 'job')).toBeNull();
    expect(transferStage('downloading', 'older-job:dl:123', 'recovering', 'job')).toBeNull();
    expect(transferStage('uploading', 'job:dl:123', 'recovering', 'job')).toBeNull();
    for (const stage of ['done', 'error', 'cancelled', 'skipped'] as const) {
      expect(transferStage(stage, 'job:dl:123', 'recovering', 'job')).toBeNull();
    }
  });

  it('keeps skipped, cancelled, completed and failed counts disjoint', () => {
    const assets = Object.fromEntries(
      ['1', '2', '3', '4'].map((id) => [id, { name: id, type: 'animation' }]),
    );
    const results = normalizeJobResults(
      [
        { id: '1', success: true },
        { id: '1', success: true },
        { id: '2', success: true, skipped: true },
        { id: '3', success: false },
        { id: 'other', success: true },
      ],
      assets,
      'Job cancelled',
      true,
    );
    expect(countJobResults(results)).toEqual({
      completed: 1,
      errors: 1,
      skipped: 1,
      cancelled: 1,
      total: 4,
    });
  });
});
