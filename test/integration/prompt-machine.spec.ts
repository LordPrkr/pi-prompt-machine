import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { listPromptMachines, loadPromptMachine } from '../../src/prompt-machines.ts';
import {
  checkpointEntry,
  foldWorkflowEntries,
  formatDisclosure,
  formatState,
  startEntry,
  startWorkflow,
  transitionWorkflow,
  WorkflowEntry,
} from '../../src/workflow.ts';

layer(NodeServices.layer)('prompt machine integration', (it) => {
  it.effect('discovers, parses, restores globals, progresses, and restores persisted state', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: 'prompt-machine-' });
      const machineDir = path.join(agentDir, 'prompt-machines');
      yield* fs.makeDirectory(machineDir);
      const fixture = yield* fs.readFileString(path.resolve('test/fixtures/fix-and-push.mmd'));
      yield* fs.writeFileString(path.join(machineDir, 'fix-and-push.mmd'), fixture);
      yield* fs.writeFileString(path.join(machineDir, 'ignored.txt'), 'ignored');

      expect(yield* listPromptMachines(agentDir)).toEqual(['fix-and-push']);
      const descriptors = new Map(
        ['window', 'document', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
      );
      const machine = yield* loadPromptMachine(agentDir, 'fix-and-push');
      for (const [key, descriptor] of descriptors) {
        expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
      }

      let record = yield* startWorkflow(machine);
      const entries: Array<unknown> = [
        { customType: 'prompt-machine', data: yield* Schema.encodeUnknownEffect(WorkflowEntry)(startEntry(record)) },
      ];
      const instructions = Object.values(machine.snapshot.instructions);
      for (const instruction of instructions) {
        const disclosure = formatDisclosure(record);
        expect(disclosure).toContain(instruction);
        for (const future of instructions.filter((candidate) => candidate !== instruction)) {
          expect(disclosure).not.toContain(future);
        }
        if (record.currentState === 'fix') {
          expect(formatState(record)).toContain('Implement the smallest root-cause fix.');
          expect(formatState(record)).not.toContain('Run the required validation commands.');
        }
        record = yield* transitionWorkflow(record, record.currentState === 'inspect' ? 'ready' : undefined);
        entries.push({
          customType: 'prompt-machine',
          data: yield* Schema.encodeUnknownEffect(WorkflowEntry)(checkpointEntry(record)),
        });
      }
      expect(record.status).toBe('completed');
      expect(yield* foldWorkflowEntries(entries)).toEqual(record);
    }).pipe(Effect.scoped),
  );
});
