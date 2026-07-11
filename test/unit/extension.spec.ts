import { expect, it } from '@effect/vitest';
import { makeTransitionReservation } from '../../extensions/prompt-machine.ts';

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
