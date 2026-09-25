import { describe, expect, it } from 'vitest';

import { buildAssetList, parseAssetIds, parseMappings } from './assets';

describe('buildAssetList', () => {
  it('lets a real property decide the type over a script-source guess', () => {
    const assets = buildAssetList({
      anims: {
        assets: [
          { assetId: '507777826', fullName: 'NPC.Walk', property: 'AnimationId' },
          { assetId: '1843463175', fullName: 'NPC.Loader', property: 'Source' },
        ],
      },
      sounds: { assets: [{ assetId: '1843463175', fullName: 'NPC.Theme', property: 'SoundId' }] },
    });
    const sound = assets.find((a) => a.id === '1843463175');
    expect(sound?.type).toBe('audio');
    expect(sound?.name).toBe('Theme');
    expect(sound?.usages.map((u) => u.property)).toEqual(['SoundId', 'Source']);
    expect(assets.find((a) => a.id === '507777826')?.type).toBe('animation');
  });

  it('drops ids too small to be real assets', () => {
    const assets = buildAssetList({
      anims: { assets: [{ assetId: '42', property: 'AnimationId' }] },
    });
    expect(assets).toEqual([]);
  });

  it('only keeps script refs whose type was resolved', () => {
    const assets = buildAssetList(
      {
        scriptRefs: {
          assets: [
            { assetId: '11111111', fullName: 'A.Script', property: 'Source' },
            { assetId: '22222222', fullName: 'A.Script', property: 'Source' },
          ],
        },
      },
      { '11111111': 'audio' },
    );
    expect(assets.map((a) => [a.id, a.type, a.fromScript])).toEqual([['11111111', 'audio', true]]);
  });
});

describe('parsing helpers', () => {
  it('extracts ids from urls and rbxassetid strings', () => {
    expect(
      parseAssetIds(
        'rbxassetid://12345678 https://create.roblox.com/store/asset/87654321/x 99999999 12',
      ),
    ).toEqual(['12345678', '87654321', '99999999']);
  });

  it('parses mapping lines in several formats', () => {
    expect(parseMappings('111111 -> 222222\n333333=444444\n555555, 666666\nlixo')).toEqual({
      '111111': '222222',
      '333333': '444444',
      '555555': '666666',
    });
  });
});
