import { describe, expect, it } from 'vitest';
import { fnCommandData } from './fn.js';

interface JsonOption {
  readonly name: string;
  readonly type?: number;
  readonly required?: boolean;
}

describe('/fn command schema', () => {
  it('keeps nickname settings inside the existing /fn anchor', () => {
    const options = (fnCommandData.toJSON().options ?? []) as readonly JsonOption[];
    const topLevelNames = options.map((option) => option.name);

    expect(fnCommandData.name).toBe('fn');
    expect(topLevelNames).toContain('list');
    expect(topLevelNames).toContain('set');
    expect(topLevelNames).toContain('me');

    const group = options.find((option) => option.name === 'nickname');
    expect(group?.type).toBe(2);
  });

  it('requires the prefix option for /fn nickname set', () => {
    const options = (fnCommandData.toJSON().options ?? []) as unknown as Array<{
      readonly name: string;
      readonly type?: number;
      readonly options?: readonly JsonOption[];
    }>;
    const group = options.find((option) => option.name === 'nickname') as
      | (JsonOption & { readonly options?: readonly JsonOption[] })
      | undefined;
    const subcommands = group?.options ?? [];
    expect(subcommands.map((option) => option.name)).toEqual([
      'view',
      'set',
      'clear',
      'enable',
      'disable',
      'me',
    ]);

    const set = subcommands.find((option) => option.name === 'set') as
      | (JsonOption & { readonly options?: readonly JsonOption[] })
      | undefined;
    expect(set?.options).toEqual([
      {
        name: 'prefix',
        description: 'Prefix such as [TAG]; brackets are kept as typed',
        type: 3,
        required: true,
        max_length: 16,
      },
    ]);
  });
});
