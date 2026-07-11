import { NodeServices } from '@effect/platform-node';
import { expect, it, layer } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';
import {
  decodeMermaidData,
  InvalidPromptMachine,
  listPromptMachines,
  loadPromptMachine,
  normalizeMermaidData,
  readPromptMachineSource,
} from '../../src/prompt-machines.ts';

const graph = {
  nodes: [
    { id: 'start', label: 'start', shape: 'stateStart', isGroup: false },
    { id: 'a', label: 'Do A', shape: 'rect', isGroup: false },
    { id: 'b', label: 'Do B', shape: 'rect', isGroup: false },
    { id: 'end', label: 'end', shape: 'stateEnd', isGroup: false },
  ],
  edges: [
    { start: 'start', end: 'a', label: '' },
    { start: 'a', end: 'b', label: 'next' },
    { start: 'b', end: 'end', label: '' },
  ],
};

it.effect('decodes and normalizes Mermaid state data', () =>
  Effect.gen(function* () {
    const data = yield* decodeMermaidData(graph);
    const machine = normalizeMermaidData(data);
    expect(machine.initialState).toBe('a');
    expect(machine.instructions).toEqual({ a: 'Do A', b: 'Do B' });
    expect(machine.transitions.a?.[0]?.name).toBe('next');
    expect(machine.transitions.b?.[0]?.terminal).toBe(true);
  }),
);

it('rejects missing instructions, ambiguous branches, unreachable states, and non-terminating cycles', () => {
  expect(() =>
    normalizeMermaidData({
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === 'a' ? { ...node, label: 'a' } : node)),
    }),
  ).toThrow(InvalidPromptMachine);
  expect(() =>
    normalizeMermaidData({ ...graph, edges: [...graph.edges, { start: 'a', end: 'end', label: '' }] }),
  ).toThrow(InvalidPromptMachine);
  expect(() =>
    normalizeMermaidData({
      ...graph,
      nodes: [...graph.nodes, { id: 'lost', label: 'Lost', shape: 'rect', isGroup: false }],
      edges: [...graph.edges, { start: 'lost', end: 'end', label: '' }],
    }),
  ).toThrow(InvalidPromptMachine);
  expect(() =>
    normalizeMermaidData({
      ...graph,
      edges: [
        { start: 'start', end: 'a', label: '' },
        { start: 'a', end: 'b', label: '' },
        { start: 'b', end: 'a', label: '' },
      ],
    }),
  ).toThrow("state 'a' cannot reach an end node");
});

it('rejects malformed boundary data', async () => {
  const exit = await Effect.runPromiseExit(decodeMermaidData({ nodes: 'wrong', edges: [] }));
  expect(exit._tag).toBe('Failure');
});

layer(NodeServices.layer)('prompt-machine resources', (it) => {
  it.effect('discovers sorted direct regular resources and enforces exact lookup and the size cap', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: 'prompt-machine-unit-' });
      const directory = path.join(agentDir, 'prompt-machines');
      yield* fs.makeDirectory(path.join(directory, 'nested'), { recursive: true });
      yield* fs.writeFileString(path.join(directory, 'z-last.mmd'), 'stateDiagram-v2');
      yield* fs.writeFileString(path.join(directory, 'a-first.mmd'), 'stateDiagram-v2');
      yield* fs.writeFileString(path.join(directory, 'state.mmd'), 'stateDiagram-v2');
      yield* fs.writeFileString(path.join(directory, 'bad name.mmd'), 'stateDiagram-v2');
      yield* fs.writeFileString(path.join(directory, 'other.txt'), 'ignored');
      yield* fs.writeFileString(path.join(directory, 'nested', 'nested.mmd'), 'stateDiagram-v2');
      yield* fs.writeFile(path.join(directory, 'large.mmd'), new Uint8Array(256 * 1024 + 1));
      yield* fs.symlink(path.join(directory, 'a-first.mmd'), path.join(directory, 'linked.mmd'));

      expect(yield* listPromptMachines(agentDir)).toEqual(['a-first', 'large', 'z-last']);
      const missing = yield* Effect.flip(loadPromptMachine(agentDir, '../a-first'));
      expect(missing._tag).toBe('PromptMachineNotFound');
      if (missing._tag !== 'PromptMachineNotFound') {
        expect.fail('expected PromptMachineNotFound');
      }
      expect(missing.available).toEqual(['a-first', 'large', 'z-last']);
      const oversized = yield* Effect.flip(loadPromptMachine(agentDir, 'large'));
      expect(oversized._tag).toBe('PromptMachineLoadError');
      if (oversized._tag !== 'PromptMachineLoadError') {
        expect.fail('expected PromptMachineLoadError');
      }
      expect(oversized.operation).toContain('256 KiB');
      const linked = yield* Effect.flip(readPromptMachineSource(path.join(directory, 'linked.mmd')));
      expect(linked._tag).toBe('PromptMachineLoadError');
    }).pipe(Effect.scoped),
  );
});
