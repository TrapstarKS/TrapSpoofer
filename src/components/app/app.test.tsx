import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { normalizeTab } from './nav';
import { VirtualList } from './VirtualList';

describe('normalizeTab', () => {
  it('keeps the new ids and maps legacy ones', () => {
    expect(normalizeTab('spoof')).toBe('spoof');
    expect(normalizeTab('mcp')).toBe('mcp');
    expect(normalizeTab('spoofing')).toBe('spoof');
    expect(normalizeTab('activity')).toBe('history');
    expect(normalizeTab('whatever')).toBe('home');
    expect(normalizeTab(undefined)).toBe('home');
  });
});

describe('VirtualList', () => {
  it('only renders the visible slice of a long list', () => {
    const items = Array.from({ length: 5000 }, (_, i) => `row-${i}`);
    render(
      <VirtualList
        items={items}
        rowHeight={40}
        getKey={(item) => item}
        renderRow={(item) => <span>{item}</span>}
      />,
    );
    expect(screen.getByText('row-0')).toBeInTheDocument();
    expect(screen.queryByText('row-4999')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeLessThan(40);
  });

  it('renders the empty slot', () => {
    render(
      <VirtualList
        items={[] as string[]}
        rowHeight={40}
        getKey={(item) => item}
        renderRow={(item) => <span>{item}</span>}
        empty={<p>nada</p>}
      />,
    );
    expect(screen.getByText('nada')).toBeInTheDocument();
  });
});
