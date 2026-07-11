import { Effect, Schema } from 'effect';
import { type LoadedPromptMachine, MachineSnapshot, type Transition } from './prompt-machines.ts';

export class WorkflowRecord extends Schema.Class<WorkflowRecord>('WorkflowRecord')({
  machine: Schema.String,
  source: Schema.String,
  snapshot: MachineSnapshot,
  status: Schema.Literals(['active', 'completed']),
  currentState: Schema.String,
  finalState: Schema.optional(Schema.String),
}) {}

export class WorkflowStartEntry extends Schema.TaggedClass<WorkflowStartEntry>()('start', {
  record: WorkflowRecord,
}) {}
export class WorkflowCheckpointEntry extends Schema.TaggedClass<WorkflowCheckpointEntry>()('checkpoint', {
  machine: Schema.String,
  status: Schema.Literals(['active', 'completed']),
  currentState: Schema.String,
  finalState: Schema.optional(Schema.String),
}) {}
export const WorkflowEntry = Schema.Union([WorkflowStartEntry, WorkflowCheckpointEntry]);
export type WorkflowEntry = typeof WorkflowEntry.Type;

const SessionEntry = Schema.Struct({
  customType: Schema.Literal('prompt-machine'),
  data: WorkflowEntry,
});

export class InvalidTransition extends Schema.TaggedErrorClass<InvalidTransition>()('InvalidTransition', {
  state: Schema.String,
  requested: Schema.optional(Schema.String),
  available: Schema.Array(Schema.String),
}) {}
export class InvalidSessionState extends Schema.TaggedErrorClass<InvalidSessionState>()('InvalidSessionState', {
  message: Schema.String,
}) {}

export const startWorkflow = Effect.fn('startWorkflow')((machine: LoadedPromptMachine) =>
  Effect.succeed(
    new WorkflowRecord({
      machine: machine.name,
      source: machine.source,
      snapshot: machine.snapshot,
      status: 'active',
      currentState: machine.snapshot.initialState,
    }),
  ),
);

const outgoingFor = (record: WorkflowRecord): ReadonlyArray<Transition> =>
  record.snapshot.transitions[record.currentState] ?? [];

export const transitionWorkflow = Effect.fn('transitionWorkflow')(function* (record: WorkflowRecord, name?: string) {
  const outgoing = outgoingFor(record);
  const available = outgoing.flatMap((edge) => (edge.name === undefined ? [] : [edge.name]));
  const selected =
    name === undefined
      ? outgoing.length === 1
        ? outgoing[0]
        : undefined
      : outgoing.find((edge) => edge.name === name);
  if (record.status === 'completed' || selected === undefined) {
    return yield* new InvalidTransition({
      state: record.currentState,
      ...(name === undefined ? {} : { requested: name }),
      available,
    });
  }
  if (selected.terminal) {
    return new WorkflowRecord({
      machine: record.machine,
      source: record.source,
      snapshot: record.snapshot,
      status: 'completed',
      currentState: record.currentState,
      finalState: record.currentState,
    });
  }
  return new WorkflowRecord({
    machine: record.machine,
    source: record.source,
    snapshot: record.snapshot,
    status: 'active',
    currentState: selected.target,
  });
});

export const formatDisclosure = (record: WorkflowRecord): string => {
  if (record.status === 'completed') {
    return `Prompt machine '${record.machine}' completed at state '${record.finalState ?? record.currentState}'.`;
  }
  const instruction = record.snapshot.instructions[record.currentState] ?? '';
  const outgoing = outgoingFor(record);
  const choices = outgoing.map((edge) => edge.name ?? '(default)').join(', ');
  const transitionGuidance =
    outgoing.length === 1
      ? 'After finishing this instruction, call prompt_machine_transition.'
      : 'After finishing this instruction, choose the transition that best matches the outcome of your work, then call prompt_machine_transition with that transition name.';
  return [
    `Current prompt-machine instruction (${record.machine}/${record.currentState}):`,
    instruction,
    `Outgoing transitions: ${choices}.`,
    transitionGuidance,
  ].join('\n');
};

export const formatState = (record: WorkflowRecord): string => {
  const lines = [
    `Machine: ${record.machine}`,
    `Status: ${record.status}`,
    `Source: ${record.source}`,
    `State: ${record.finalState ?? record.currentState}`,
  ];
  if (record.status === 'active') {
    lines.push(`Instruction: ${record.snapshot.instructions[record.currentState] ?? ''}`, 'Transitions:');
    for (const edge of outgoingFor(record)) {
      lines.push(`- ${edge.name ?? '(default)'} -> ${edge.terminal ? '[*]' : edge.target}`);
    }
  }
  return lines.join('\n');
};

export const startEntry = (record: WorkflowRecord): WorkflowStartEntry => new WorkflowStartEntry({ record });
export const checkpointEntry = (record: WorkflowRecord): WorkflowCheckpointEntry =>
  new WorkflowCheckpointEntry({
    machine: record.machine,
    status: record.status,
    currentState: record.currentState,
    ...(record.finalState === undefined ? {} : { finalState: record.finalState }),
  });

export const encodeWorkflowEntry = Schema.encodeUnknownEffect(WorkflowEntry);

const invalidSession = (message: string): InvalidSessionState => new InvalidSessionState({ message });

const validateStartRecord = (record: WorkflowRecord): string | undefined => {
  if (record.status !== 'active' || record.finalState !== undefined) {
    return 'start entry must be active without a final state';
  }
  if (record.currentState !== record.snapshot.initialState) {
    return 'start entry does not reference the initial state';
  }
  if (record.snapshot.instructions[record.currentState] === undefined) {
    return `start entry references unknown state '${record.currentState}'`;
  }
  return undefined;
};

const applyCheckpoint = (
  record: WorkflowRecord,
  entry: WorkflowCheckpointEntry,
): WorkflowRecord | InvalidSessionState => {
  if (record.status === 'completed') {
    return invalidSession('checkpoint follows a completed workflow');
  }
  if (record.machine !== entry.machine) {
    return invalidSession('checkpoint has no matching start entry');
  }
  const outgoing = outgoingFor(record);
  if (entry.status === 'completed') {
    if (
      entry.finalState !== entry.currentState ||
      entry.currentState !== record.currentState ||
      !outgoing.some((edge) => edge.terminal)
    ) {
      return invalidSession('completed checkpoint does not follow a terminal transition');
    }
  } else if (
    entry.finalState !== undefined ||
    !outgoing.some((edge) => !edge.terminal && edge.target === entry.currentState)
  ) {
    return invalidSession('active checkpoint does not follow an outgoing transition');
  }
  return new WorkflowRecord({
    machine: record.machine,
    source: record.source,
    snapshot: record.snapshot,
    status: entry.status,
    currentState: entry.currentState,
    ...(entry.finalState === undefined ? {} : { finalState: entry.finalState }),
  });
};

export const foldWorkflowEntries = Effect.fn('foldWorkflowEntries')(function* (entries: ReadonlyArray<unknown>) {
  let record: WorkflowRecord | undefined;
  for (const candidate of entries) {
    const decoded = yield* Schema.decodeUnknownEffect(SessionEntry)(candidate).pipe(Effect.option);
    if (decoded._tag === 'None') {
      const maybePromptMachine = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ customType: Schema.optional(Schema.String) }),
      )(candidate).pipe(Effect.option);
      if (maybePromptMachine._tag === 'Some' && maybePromptMachine.value.customType === 'prompt-machine') {
        return yield* invalidSession('malformed prompt-machine session entry');
      }
      continue;
    }
    const entry = decoded.value.data;
    if (entry._tag === 'start') {
      const error = validateStartRecord(entry.record);
      if (error !== undefined) {
        return yield* invalidSession(error);
      }
      record = entry.record;
      continue;
    }
    if (record === undefined) {
      return yield* invalidSession('checkpoint has no matching start entry');
    }
    const next = applyCheckpoint(record, entry);
    if (Schema.is(InvalidSessionState)(next)) {
      return yield* next;
    }
    record = next;
  }
  return record;
});
