import { NodeServices } from '@effect/platform-node';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Effect, ManagedRuntime } from 'effect';
import { Type } from 'typebox';
import { listPromptMachines, loadPromptMachine, type PromptMachineError } from '../src/prompt-machines.ts';
import {
  checkpointEntry,
  encodeWorkflowEntry,
  foldWorkflowEntries,
  formatDisclosure,
  formatInitialDisclosure,
  formatState,
  type InvalidSessionState,
  type InvalidTransition,
  startEntry,
  startWorkflow,
  transitionWorkflow,
  type WorkflowRecord,
} from '../src/workflow.ts';

const CUSTOM_TYPE = 'prompt-machine';
const TransitionParams = Type.Object({
  transition: Type.Optional(Type.String({ description: 'Outgoing transition name; omit only when there is one edge' })),
});
interface TransitionDetails {
  readonly status: 'idle' | 'error' | 'active' | 'completed';
  readonly machine?: string;
  readonly state?: string;
  readonly transitions?: ReadonlyArray<string>;
}
type ExpectedError = PromptMachineError | InvalidTransition | InvalidSessionState;

export type PromptMachineCommand =
  | { readonly action: 'start'; readonly name: string; readonly prompt?: string }
  | { readonly action: 'state' }
  | { readonly action: 'transition'; readonly transition?: string }
  | { readonly action: 'invalid' };

export const parsePromptMachineCommand = (raw: string): PromptMachineCommand => {
  const input = raw.trim();
  if (!input) {
    return { action: 'invalid' };
  }
  const separator = input.search(/\s/);
  const command = separator === -1 ? input : input.slice(0, separator);
  const remainder = separator === -1 ? '' : input.slice(separator).trim();
  if (command === 'state') {
    return remainder ? { action: 'invalid' } : { action: 'state' };
  }
  if (command === 'transition') {
    if (!remainder) {
      return { action: 'transition' };
    }
    return /\s/.test(remainder) ? { action: 'invalid' } : { action: 'transition', transition: remainder };
  }
  return remainder ? { action: 'start', name: command, prompt: remainder } : { action: 'start', name: command };
};

export const makeTransitionReservation = () => {
  let reservedCallId: string | undefined;
  return {
    reserve(callId: string): boolean {
      if (reservedCallId !== undefined) {
        return false;
      }
      reservedCallId = callId;
      return true;
    },
    release(callId: string): void {
      if (reservedCallId === callId) {
        reservedCallId = undefined;
      }
    },
    reset(): void {
      reservedCallId = undefined;
    },
  };
};

const errorMessage = (error: ExpectedError): string => {
  switch (error._tag) {
    case 'PromptMachineNotFound':
      return `Prompt machine '${error.name}' not found. Available: ${error.available.join(', ') || '(none)'}.`;
    case 'PromptMachineLoadError':
      return `Could not ${error.operation} '${error.path}'.`;
    case 'PromptMachineParseError':
      return `Could not parse prompt machine '${error.name}'.`;
    case 'InvalidPromptMachine':
      return `Invalid prompt machine: ${error.message}`;
    case 'InvalidTransition':
      return `Invalid transition from '${error.state}'. Available: ${error.available.join(', ') || '(none)'}.`;
    case 'InvalidSessionState':
      return `Invalid saved prompt-machine state: ${error.message}`;
  }
};

export default function promptMachineExtension(pi: ExtensionAPI): void {
  const runtime = ManagedRuntime.make(NodeServices.layer);
  const agentDir = getAgentDir();
  let current: WorkflowRecord | undefined;
  let discovered: ReadonlyArray<string> = [];
  const transitionReservation = makeTransitionReservation();

  const updateStatus = (ctx: ExtensionContext): void => {
    const status =
      current === undefined
        ? undefined
        : current.status === 'completed'
          ? `${current.machine}:completed`
          : `${current.machine}:${current.currentState}`;
    ctx.ui.setStatus('prompt-machine', status);
  };

  const refresh = async (): Promise<void> => {
    const result = await runtime.runPromise(
      listPromptMachines(agentDir).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    );
    if (result.ok) {
      discovered = result.value;
    }
  };

  const persistStart = async (record: WorkflowRecord): Promise<void> => {
    pi.appendEntry(CUSTOM_TYPE, await runtime.runPromise(encodeWorkflowEntry(startEntry(record))));
  };

  const persistCheckpoint = async (record: WorkflowRecord): Promise<void> => {
    pi.appendEntry(CUSTOM_TYPE, await runtime.runPromise(encodeWorkflowEntry(checkpointEntry(record))));
  };

  const restore = async (entries: ReadonlyArray<unknown>, notify: (message: string) => void): Promise<void> => {
    const result = await runtime.runPromise(
      foldWorkflowEntries(entries).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    );
    if (!result.ok) {
      current = undefined;
      notify(errorMessage(result.error));
    } else {
      current = result.value;
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    await refresh();
    await restore(ctx.sessionManager.getBranch(), (message) => ctx.ui.notify(message, 'error'));
    updateStatus(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => {
    await restore(ctx.sessionManager.getBranch(), (message) => ctx.ui.notify(message, 'error'));
    updateStatus(ctx);
  });
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'prompt_machine_transition') {
      return;
    }
    if (!transitionReservation.reserve(event.toolCallId)) {
      return { block: true, reason: 'Only one prompt-machine transition is allowed per tool batch.' };
    }
  });
  pi.on('tool_execution_end', (event) => {
    transitionReservation.release(event.toolCallId);
  });
  pi.on('turn_end', async () => {
    transitionReservation.reset();
  });
  pi.on('session_shutdown', async () => {
    await runtime.dispose();
  });

  pi.registerCommand('prompt-machine', {
    description: 'Start, advance, or inspect a progressive-disclosure prompt machine',
    getArgumentCompletions: (prefix) => {
      const input = prefix.trimStart();
      const parts = input.split(/\s+/);
      if (parts[0] !== 'transition' && /\s/.test(input)) {
        return null;
      }
      const values =
        parts[0] === 'transition' && parts.length > 1 && current?.status === 'active'
          ? (current.snapshot.transitions[current.currentState] ?? []).flatMap((edge) =>
              edge.name === undefined ? [] : [edge.name],
            )
          : ['state', 'transition', ...discovered];
      const token = parts.at(-1) ?? '';
      const matches = values.filter((value) => value.startsWith(token)).map((value) => ({ value, label: value }));
      return matches.length === 0 ? null : matches;
    },
    handler: async (rawArgs, ctx) => {
      const command = parsePromptMachineCommand(rawArgs);
      if (command.action === 'state') {
        ctx.ui.notify(current === undefined ? 'No active prompt machine.' : formatState(current), 'info');
        return;
      }
      if (command.action === 'invalid') {
        await refresh();
        ctx.ui.notify(
          `Usage: /prompt-machine <name> [prompt] | transition [name] | state\nAvailable: ${discovered.join(', ') || '(none)'}`,
          'error',
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify('Prompt-machine changes require Pi to be idle.', 'error');
        return;
      }
      if (command.action === 'transition') {
        if (current === undefined) {
          ctx.ui.notify('No active prompt machine.', 'error');
          return;
        }
        const result = await runtime.runPromise(
          transitionWorkflow(current, command.transition).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        );
        if (!result.ok) {
          ctx.ui.notify(errorMessage(result.error), 'error');
          return;
        }
        current = result.value;
        await persistCheckpoint(current);
        updateStatus(ctx);
        pi.sendUserMessage(formatDisclosure(current));
        return;
      }
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const machine = yield* loadPromptMachine(agentDir, command.name);
          return yield* startWorkflow(machine);
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        ),
      );
      if (!result.ok) {
        ctx.ui.notify(errorMessage(result.error), 'error');
        return;
      }
      current = result.value;
      await persistStart(current);
      updateStatus(ctx);
      pi.sendUserMessage(formatInitialDisclosure(current, command.prompt));
    },
  });

  pi.registerTool<typeof TransitionParams, TransitionDetails>({
    name: 'prompt_machine_transition',
    label: 'Prompt machine transition',
    description: 'Assert the current prompt-machine instruction is complete and advance to an outgoing transition.',
    promptSnippet: 'Advance the active prompt machine when its current instruction is complete.',
    promptGuidelines: [
      'You must call prompt_machine_transition when the current prompt-machine instruction is complete; when several transitions are available, pass the transition name that matches the outcome of the work.',
    ],
    parameters: TransitionParams,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (current === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'No active prompt machine.' }],
          details: { status: 'idle' as const },
        };
      }
      const result = await runtime.runPromise(
        transitionWorkflow(current, params.transition).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        ),
        { signal },
      );
      if (!result.ok) {
        throw new Error(errorMessage(result.error));
      }
      current = result.value;
      await persistCheckpoint(current);
      updateStatus(ctx);
      const outgoing = current.snapshot.transitions[current.currentState] ?? [];
      return {
        content: [{ type: 'text' as const, text: formatDisclosure(current) }],
        details: {
          status: current.status,
          machine: current.machine,
          state: current.finalState ?? current.currentState,
          transitions: outgoing.flatMap((edge) => (edge.name === undefined ? [] : [edge.name])),
        },
        terminate: current.status === 'completed',
      };
    },
  });
}
