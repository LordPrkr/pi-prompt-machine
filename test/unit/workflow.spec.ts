import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { LoadedPromptMachine, MachineSnapshot, Transition } from '../../src/prompt-machines.ts';
import {
  checkpointEntry,
  foldWorkflowEntries,
  formatDisclosure,
  formatState,
  startEntry,
  startWorkflow,
  transitionWorkflow,
} from '../../src/workflow.ts';

const machine = new LoadedPromptMachine({
  name: 'review',
  source: '/agent/prompt-machines/review.mmd',
  snapshot: new MachineSnapshot({
    initialState: 'inspect',
    instructions: { inspect: 'Inspect the change', approve: 'Approve it', revise: 'Revise it' },
    transitions: {
      inspect: [
        new Transition({ name: 'approve', target: 'approve', terminal: false }),
        new Transition({ name: 'revise', target: 'revise', terminal: false }),
      ],
      approve: [new Transition({ target: 'end', terminal: true })],
      revise: [new Transition({ target: 'end', terminal: true })],
    },
  }),
});

it.effect('starts, selects a named branch, and completes while disclosing only the current instruction', () =>
  Effect.gen(function* () {
    const started = yield* startWorkflow(machine);
    expect(formatDisclosure(started)).toContain('Inspect the change');
    expect(formatDisclosure(started)).not.toContain('Approve it');
    expect(formatDisclosure(started)).toContain(
      'choose the transition that best matches the outcome of your work, then call prompt_machine_transition with that transition name',
    );
    const approved = yield* transitionWorkflow(started, 'approve');
    expect(formatDisclosure(approved)).toContain('After finishing this instruction, call prompt_machine_transition.');
    expect(formatDisclosure(approved)).not.toContain('choose the transition');
    expect(formatState(approved)).toContain('Approve it');
    expect(formatState(approved)).not.toContain('Revise it');
    const completed = yield* transitionWorkflow(approved);
    expect(completed.status).toBe('completed');
    expect(completed.finalState).toBe('approve');
  }),
);

it.effect('rejects omitted ambiguous and unknown transitions', () =>
  Effect.gen(function* () {
    const started = yield* startWorkflow(machine);
    expect((yield* Effect.flip(transitionWorkflow(started)))._tag).toBe('InvalidTransition');
    expect((yield* Effect.flip(transitionWorkflow(started, 'missing'))).available).toEqual(['approve', 'revise']);
  }),
);

it.effect('folds branch-local entries and lets later starts replace earlier machines', () =>
  Effect.gen(function* () {
    const started = yield* startWorkflow(machine);
    const approved = yield* transitionWorkflow(started, 'approve');
    const completed = yield* transitionWorkflow(approved);
    const folded = yield* foldWorkflowEntries([
      { customType: 'prompt-machine', data: startEntry(started) },
      { customType: 'prompt-machine', data: checkpointEntry(approved) },
      { customType: 'prompt-machine', data: checkpointEntry(completed) },
    ]);
    expect(folded).toEqual(completed);
  }),
);

it.effect('rejects impossible persisted starts and checkpoint jumps', () =>
  Effect.gen(function* () {
    const started = yield* startWorkflow(machine);
    const invalidStart = yield* Effect.flip(
      foldWorkflowEntries([
        {
          customType: 'prompt-machine',
          data: {
            _tag: 'start',
            record: { ...started, status: 'completed', finalState: started.currentState },
          },
        },
      ]),
    );
    expect(invalidStart.message).toContain('start entry must be active');

    const illegalJump = yield* Effect.flip(
      foldWorkflowEntries([
        { customType: 'prompt-machine', data: startEntry(started) },
        {
          customType: 'prompt-machine',
          data: {
            _tag: 'checkpoint',
            machine: started.machine,
            status: 'active',
            currentState: started.currentState,
          },
        },
      ]),
    );
    expect(illegalJump.message).toContain('does not follow an outgoing transition');

    const invalidCompletion = yield* Effect.flip(
      foldWorkflowEntries([
        { customType: 'prompt-machine', data: startEntry(started) },
        {
          customType: 'prompt-machine',
          data: {
            _tag: 'checkpoint',
            machine: started.machine,
            status: 'completed',
            currentState: started.currentState,
          },
        },
      ]),
    );
    expect(invalidCompletion.message).toContain('does not follow a terminal transition');
  }),
);
