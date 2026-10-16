import { expect, it } from 'vitest';
import { changedStatuses, type StatusUpdate } from './sidebar.js';

it('does not republish equal status objects on every poll, but preserves changes and clears', () => {
  const previous: StatusUpdate = {
    button: { status: 'error', title: 'juxtapose', description: '3% changed' },
    card: { status: 'success', title: 'juxtapose', description: 'baseline matches' },
  };
  expect(changedStatuses(structuredClone(previous), previous)).toEqual({});
  const next: StatusUpdate = {
    button: { ...previous.button!, status: 'success', description: 'baseline matches' },
    card: null,
    input: { status: 'warn', title: 'juxtapose', description: 'no baseline yet' },
  };
  expect(changedStatuses(next, previous)).toEqual(next);
  expect(changedStatuses({ card: null }, next)).toEqual({});
  expect(
    changedStatuses(
      { button: { ...previous.button!, description: '4% changed' } },
      previous,
    ),
  ).toHaveProperty('button.description', '4% changed');
});
