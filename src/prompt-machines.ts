import { Effect, FileSystem, Option, Path, Schema } from 'effect';
import { Window } from 'happy-dom';

const MAX_SOURCE_BYTES = 256 * 1024;
const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RESERVED = new Set(['state', 'transition']);

export class Transition extends Schema.Class<Transition>('Transition')({
  name: Schema.optional(Schema.String),
  target: Schema.String,
  terminal: Schema.Boolean,
}) {}

export class MachineSnapshot extends Schema.Class<MachineSnapshot>('MachineSnapshot')({
  initialState: Schema.String,
  instructions: Schema.Record(Schema.String, Schema.String),
  transitions: Schema.Record(Schema.String, Schema.Array(Transition)),
}) {}

export class LoadedPromptMachine extends Schema.Class<LoadedPromptMachine>('LoadedPromptMachine')({
  name: Schema.String,
  source: Schema.String,
  snapshot: MachineSnapshot,
}) {}

export class PromptMachineNotFound extends Schema.TaggedErrorClass<PromptMachineNotFound>()('PromptMachineNotFound', {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {}
export class PromptMachineLoadError extends Schema.TaggedErrorClass<PromptMachineLoadError>()(
  'PromptMachineLoadError',
  {
    operation: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}
export class PromptMachineParseError extends Schema.TaggedErrorClass<PromptMachineParseError>()(
  'PromptMachineParseError',
  {
    name: Schema.String,
    cause: Schema.Defect(),
  },
) {}
export class InvalidPromptMachine extends Schema.TaggedErrorClass<InvalidPromptMachine>()('InvalidPromptMachine', {
  message: Schema.String,
}) {}

export type PromptMachineError =
  | PromptMachineNotFound
  | PromptMachineLoadError
  | PromptMachineParseError
  | InvalidPromptMachine;

const MermaidNode = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  shape: Schema.String,
  isGroup: Schema.Boolean,
});
const MermaidEdge = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
  label: Schema.String,
});
export const MermaidData = Schema.Struct({
  nodes: Schema.Array(MermaidNode),
  edges: Schema.Array(MermaidEdge),
});
export type MermaidData = typeof MermaidData.Type;
export const decodeMermaidData = Schema.decodeUnknownEffect(MermaidData);

const invalid = (message: string): InvalidPromptMachine => new InvalidPromptMachine({ message });

export const normalizeMermaidData = (data: MermaidData): MachineSnapshot => {
  if (data.nodes.some((node) => node.isGroup)) {
    throw invalid('composite or grouped states are not supported');
  }
  const unsupported = data.nodes.find((node) => !['rect', 'stateStart', 'stateEnd'].includes(node.shape));
  if (unsupported) {
    throw invalid(`unsupported state shape '${unsupported.shape}'`);
  }
  const starts = data.nodes.filter((node) => node.shape === 'stateStart');
  if (starts.length !== 1) {
    throw invalid(`expected exactly one start node, found ${starts.length}`);
  }
  const startEdges = data.edges.filter((edge) => edge.start === starts[0]?.id);
  if (startEdges.length !== 1) {
    throw invalid(`expected exactly one start edge, found ${startEdges.length}`);
  }
  const ordinary = data.nodes.filter((node) => node.shape === 'rect');
  const ordinaryIds = new Set(ordinary.map((node) => node.id));
  const endIds = new Set(data.nodes.filter((node) => node.shape === 'stateEnd').map((node) => node.id));
  const initialState = startEdges[0]?.end ?? '';
  if (!ordinaryIds.has(initialState)) {
    throw invalid(`start edge targets unknown state '${initialState}'`);
  }
  const instructions: Record<string, string> = {};
  const transitions: Record<string, Array<Transition>> = {};
  for (const node of ordinary) {
    if (node.label.trim().length === 0 || node.label === node.id) {
      throw invalid(`state '${node.id}' must have an explicit non-empty instruction`);
    }
    instructions[node.id] = node.label.trim();
    transitions[node.id] = [];
  }
  for (const edge of data.edges) {
    if (edge.start === starts[0]?.id) {
      continue;
    }
    if (!ordinaryIds.has(edge.start)) {
      throw invalid(`transition starts at unknown state '${edge.start}'`);
    }
    const terminal = endIds.has(edge.end);
    if (!terminal && !ordinaryIds.has(edge.end)) {
      throw invalid(`transition targets unknown state '${edge.end}'`);
    }
    transitions[edge.start]?.push(
      new Transition({ ...(edge.label.trim() ? { name: edge.label.trim() } : {}), target: edge.end, terminal }),
    );
  }
  for (const [state, outgoing] of Object.entries(transitions)) {
    const names = outgoing.flatMap((edge) => (edge.name === undefined ? [] : [edge.name]));
    if (new Set(names).size !== names.length) {
      throw invalid(`state '${state}' has duplicate transition names`);
    }
    if (outgoing.length > 1 && outgoing.some((edge) => edge.name === undefined)) {
      throw invalid(`state '${state}' has unnamed transitions on a multi-edge branch`);
    }
  }
  const reachable = new Set<string>();
  const pending = [initialState];
  while (pending.length > 0) {
    const state = pending.pop();
    if (state === undefined || reachable.has(state)) {
      continue;
    }
    reachable.add(state);
    for (const edge of transitions[state] ?? []) {
      if (!edge.terminal) {
        pending.push(edge.target);
      }
    }
  }
  const unreachable = ordinary.find((node) => !reachable.has(node.id));
  if (unreachable) {
    throw invalid(`state '${unreachable.id}' is unreachable`);
  }
  if (ordinary.some((node) => (transitions[node.id]?.length ?? 0) === 0)) {
    throw invalid('every state must lead to another state or an end node');
  }
  const canReachEnd = new Set(
    Object.entries(transitions)
      .filter(([, outgoing]) => outgoing.some((edge) => edge.terminal))
      .map(([state]) => state),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [state, outgoing] of Object.entries(transitions)) {
      if (!canReachEnd.has(state) && outgoing.some((edge) => !edge.terminal && canReachEnd.has(edge.target))) {
        canReachEnd.add(state);
        changed = true;
      }
    }
  }
  const nonTerminating = ordinary.find((node) => !canReachEnd.has(node.id));
  if (nonTerminating) {
    throw invalid(`state '${nonTerminating.id}' cannot reach an end node`);
  }
  return new MachineSnapshot({ initialState, instructions, transitions });
};

const loadMermaid = Effect.acquireUseRelease(
  Effect.sync(() => {
    const window = new Window();
    const keys = [
      'window',
      'document',
      'navigator',
      'DOMParser',
      'Node',
      'Element',
      'HTMLElement',
      'SVGElement',
      'CSSStyleSheet',
    ];
    const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of keys) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: Reflect.get(window, key) });
    }
    return { keys, originals };
  }),
  () => Effect.tryPromise(() => import('mermaid')),
  ({ keys, originals }) =>
    Effect.sync(() => {
      for (const key of keys) {
        const descriptor = originals.get(key);
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, key);
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
    }),
).pipe(
  Effect.map((module) => {
    module.default.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return module.default;
  }),
  Effect.cached,
  Effect.runSync,
);

export const listPromptMachines = Effect.fn('listPromptMachines')(function* (agentDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(agentDir, 'prompt-machines');
  const exists = yield* fs
    .exists(directory)
    .pipe(Effect.mapError((cause) => new PromptMachineLoadError({ operation: 'access', path: directory, cause })));
  if (!exists) {
    return [];
  }
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(
      Effect.mapError((cause) => new PromptMachineLoadError({ operation: 'read directory', path: directory, cause })),
    );
  const names: Array<string> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.mmd')) {
      continue;
    }
    const name = entry.slice(0, -4);
    if (!MACHINE_NAME.test(name) || RESERVED.has(name)) {
      continue;
    }
    const file = path.join(directory, entry);
    const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type === 'File') {
      names.push(name);
    }
  }
  return names.sort();
});

export const readPromptMachineSource = Effect.fn('readPromptMachineSource')(function* (source: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const file = yield* fs.open(source, { flag: 'r' });
    const info = yield* file.stat;
    if (info.type !== 'File') {
      return yield* Effect.fail('not a regular file');
    }
    const bytes = Option.getOrElse(
      yield* file.readAlloc(FileSystem.Size(MAX_SOURCE_BYTES + 1)),
      () => new Uint8Array(),
    );
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      return yield* Effect.fail('maximum 256 KiB exceeded');
    }
    return new TextDecoder().decode(bytes);
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new PromptMachineLoadError({
          operation: String(cause).includes('maximum 256 KiB') ? 'read (maximum 256 KiB)' : 'read',
          path: source,
          cause,
        }),
    ),
  );
});

export const loadPromptMachine = Effect.fn('loadPromptMachine')(function* (agentDir: string, name: string) {
  const path = yield* Path.Path;
  const available = yield* listPromptMachines(agentDir);
  if (!available.includes(name)) {
    return yield* new PromptMachineNotFound({ name, available });
  }
  const source = path.join(agentDir, 'prompt-machines', `${name}.mmd`);
  const text = yield* readPromptMachineSource(source);
  const mermaid = yield* loadMermaid.pipe(Effect.mapError((cause) => new PromptMachineParseError({ name, cause })));
  const raw = yield* Effect.tryPromise({
    try: async () => {
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
      const getData = Reflect.get(diagram.db, 'getData');
      if (typeof getData !== 'function') {
        throw new Error('Mermaid state database does not expose getData()');
      }
      return Reflect.apply(getData, diagram.db, []);
    },
    catch: (cause) => new PromptMachineParseError({ name, cause }),
  });
  const data = yield* decodeMermaidData(raw).pipe(
    Effect.mapError((cause) => new PromptMachineParseError({ name, cause })),
  );
  const snapshot = yield* Effect.try({
    try: () => normalizeMermaidData(data),
    catch: (cause) => (Schema.is(InvalidPromptMachine)(cause) ? cause : invalid(String(cause))),
  });
  return new LoadedPromptMachine({ name, source, snapshot });
});
