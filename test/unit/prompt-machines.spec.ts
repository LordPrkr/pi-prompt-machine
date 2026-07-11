import { NodeServices } from '@effect/platform-node';
import { expect, it, layer } from '@effect/vitest';
import { Effect, FileSystem, Path } from 'effect';
import { describe } from 'vitest';
import {
  decodeMermaidData,
  InvalidPromptMachine,
  listPromptMachines,
  loadPromptMachine,
  normalizeMermaidData,
  readPromptMachineSource,
} from '../../src/prompt-machines.ts';

const machineSource = (instruction: string) => `stateDiagram-v2
  [*] --> run
  run: ${instruction}
  run --> [*]
`;

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

describe('prompt machines', () => {
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
    it.effect('resolves flat and directory resources with flat precedence and direct-only discovery', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: 'prompt-machine-unit-' });
        const directory = path.join(agentDir, 'prompt-machines');
        yield* fs.makeDirectory(path.join(directory, 'nested'), { recursive: true });
        yield* fs.makeDirectory(path.join(directory, 'bundled', 'templates'), { recursive: true });
        yield* fs.makeDirectory(path.join(directory, 'a-first'), { recursive: true });
        yield* fs.makeDirectory(path.join(directory, 'invalid', 'MACHINE.mmd'), { recursive: true });
        yield* fs.writeFileString(path.join(directory, 'z-last.mmd'), 'stateDiagram-v2');
        yield* fs.writeFileString(path.join(directory, 'B.mmd'), 'stateDiagram-v2');
        yield* fs.writeFileString(path.join(directory, 'a_b.mmd'), 'stateDiagram-v2');
        yield* fs.writeFileString(path.join(directory, 'a-first.mmd'), machineSource('Use the flat machine.'));
        yield* fs.writeFileString(path.join(directory, 'a-first', 'MACHINE.mmd'), machineSource('Wrong source.'));
        yield* fs.writeFileString(path.join(directory, 'bundled', 'MACHINE.mmd'), machineSource('Use the bundle.'));
        yield* fs.writeFileString(path.join(directory, 'bundled', 'templates', 'supporting.mmd'), 'support only');
        yield* fs.writeFileString(path.join(directory, 'state.mmd'), 'stateDiagram-v2');
        yield* fs.writeFileString(path.join(directory, 'bad name.mmd'), 'stateDiagram-v2');
        yield* fs.writeFileString(path.join(directory, 'other.txt'), 'ignored');
        yield* fs.writeFileString(path.join(directory, 'nested', 'nested.mmd'), 'stateDiagram-v2');
        yield* fs.writeFile(path.join(directory, 'large.mmd'), new Uint8Array(256 * 1024 + 1));
        yield* fs.symlink(path.join(directory, 'a-first.mmd'), path.join(directory, 'linked.mmd'));

        expect(yield* listPromptMachines(agentDir)).toEqual([
          'B',
          'a-first',
          'a_b',
          'bundled',
          'large',
          'linked',
          'z-last',
        ]);
        const flat = yield* loadPromptMachine(agentDir, 'a-first');
        expect(flat.source).toBe(path.join(directory, 'a-first.mmd'));
        expect(flat.snapshot.instructions.run).toBe('Use the flat machine.');
        const bundled = yield* loadPromptMachine(agentDir, 'bundled');
        expect(bundled.source).toBe(path.join(directory, 'bundled', 'MACHINE.mmd'));
        expect(bundled.snapshot.instructions.run).toBe('Use the bundle.');

        const missing = yield* Effect.flip(loadPromptMachine(agentDir, '../a-first'));
        expect(missing._tag).toBe('PromptMachineNotFound');
        if (missing._tag !== 'PromptMachineNotFound') {
          expect.fail('expected PromptMachineNotFound');
        }
        expect(missing.available).toEqual(['B', 'a-first', 'a_b', 'bundled', 'large', 'linked', 'z-last']);
        const oversized = yield* Effect.flip(loadPromptMachine(agentDir, 'large'));
        expect(oversized._tag).toBe('PromptMachineLoadError');
        if (oversized._tag !== 'PromptMachineLoadError') {
          expect.fail('expected PromptMachineLoadError');
        }
        expect(oversized.operation).toContain('256 KiB');
        expect(yield* readPromptMachineSource(path.join(directory, 'linked.mmd'))).toBe(
          machineSource('Use the flat machine.'),
        );
      }).pipe(Effect.scoped),
    );
  });
});
