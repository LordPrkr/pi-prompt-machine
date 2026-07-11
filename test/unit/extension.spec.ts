import { expect, it } from '@effect/vitest';
import { describe } from 'vitest';
import { makeTransitionReservation, parsePromptMachineCommand } from '../../extensions/prompt-machine.ts';

describe('prompt-machine extension helpers', () => {
  it('parses machine prompts while preserving their content and reserved commands', () => {
    expect(parsePromptMachineCommand('code-brain-planning')).toEqual({
      action: 'start',
      name: 'code-brain-planning',
    });
    expect(parsePromptMachineCommand('code-brain-planning Wrap tests in describe blocks')).toEqual({
      action: 'start',
      name: 'code-brain-planning',
      prompt: 'Wrap tests in describe blocks',
    });
    expect(parsePromptMachineCommand('code-brain-planning  First line\n  second line')).toEqual({
      action: 'start',
      name: 'code-brain-planning',
      prompt: 'First line\n  second line',
    });
    expect(parsePromptMachineCommand('state')).toEqual({ action: 'state' });
    expect(parsePromptMachineCommand('transition approved')).toEqual({ action: 'transition', transition: 'approved' });
    expect(parsePromptMachineCommand('state extra')).toEqual({ action: 'invalid' });
    expect(parsePromptMachineCommand('transition two words')).toEqual({ action: 'invalid' });
  });

  it('reserves only the first transition in a tool batch and resets safely', () => {
    const reservation = makeTransitionReservation();

    expect(reservation.reserve('first')).toBe(true);
    expect(reservation.reserve('sibling')).toBe(false);

    reservation.release('sibling');
    expect(reservation.reserve('still-blocked')).toBe(false);

    reservation.release('first');
    expect(reservation.reserve('next-turn')).toBe(true);

    reservation.reset();
    expect(reservation.reserve('after-fallback')).toBe(true);
  });
});
