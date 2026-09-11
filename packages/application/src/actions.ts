/**
 * Capability-driven diagnostic actions (target architecture §7).
 *
 * Instead of feature flags and brand switches, every diagnostic function is
 * an *action*: it declares which capabilities an ECU must have and which
 * preconditions must hold. The UI builds its menus from `available()` —
 * a new function (Flash ECU) is a new action module, not a change to the
 * engine, the app and every protocol file.
 */

import type { DiagnosticCapability, EcuSummary, VehicleStateReading, WriteOperationKind } from '@vdp/domain';
import { capabilitiesOf, missingCapabilities } from '@vdp/domain';

/** What an action needs to know about the current situation. */
export interface DiagnosticContext {
  /** True once a vehicle session is open. */
  connected: boolean;
  /** The ECU the action targets, when it is ECU-scoped. */
  ecu?: EcuSummary;
  /** Vehicle preconditions, when known. */
  vehicleState?: VehicleStateReading;
}

export interface ActionVerdict {
  ok: boolean;
  /** Why the action cannot run right now (precondition language). */
  reason?: string;
}

export interface ActionDescriptor {
  id: string;
  name: string;
  /**
   * Read actions carry `'read'`; write actions carry their kind so risk
   * policy and safety chain apply (domain §15).
   */
  operation: 'read' | WriteOperationKind;
  requiredCapabilities: readonly DiagnosticCapability[];
  description?: string;
}

export interface DiagnosticActionDefinition extends ActionDescriptor {
  canExecute(context: DiagnosticContext): ActionVerdict;
}

export class ActionRegistry {
  private readonly actions = new Map<string, DiagnosticActionDefinition>();

  register(action: DiagnosticActionDefinition): void {
    if (this.actions.has(action.id)) throw new Error(`action "${action.id}" is already registered`);
    this.actions.set(action.id, action);
  }

  get(id: string): DiagnosticActionDefinition | undefined {
    return this.actions.get(id);
  }

  list(): ActionDescriptor[] {
    return Array.from(this.actions.values()).map(({ id, name, operation, requiredCapabilities, description }) => ({
      id,
      name,
      operation,
      requiredCapabilities,
      ...(description !== undefined ? { description } : {}),
    }));
  }

  /**
   * The actions executable right now: preconditions pass *and* the target ECU
   * (when given) holds every required capability. Without an ECU only
   * actions that need no capabilities qualify.
   */
  available(context: DiagnosticContext): ActionDescriptor[] {
    const result: ActionDescriptor[] = [];
    for (const action of this.actions.values()) {
      const verdict = action.canExecute(context);
      if (!verdict.ok) continue;
      const ecuCapabilities = context.ecu ? capabilitiesOf(...context.ecu.capabilities) : capabilitiesOf();
      if (missingCapabilities(ecuCapabilities, action.requiredCapabilities).length > 0) continue;
      result.push({
        id: action.id,
        name: action.name,
        operation: action.operation,
        requiredCapabilities: action.requiredCapabilities,
        ...(action.description !== undefined ? { description: action.description } : {}),
      });
    }
    return result;
  }
}

/**
 * The standard action set available on any UDS platform. Write actions that
 * need more than plain UDS services (coding, adaptation, flash) are added by
 * their own modules once those features exist.
 */
export function createStandardActions(): readonly DiagnosticActionDefinition[] {
  return [
    {
      id: 'dtc.read',
      name: 'Read fault memory',
      operation: 'read',
      requiredCapabilities: ['read-dtc'],
      description: 'Read stored fault codes incl. status and enrichment.',
      canExecute: (context) =>
        !context.connected
          ? { ok: false, reason: 'no vehicle connection' }
          : context.ecu === undefined
            ? { ok: false, reason: 'no ECU selected' }
            : { ok: true },
    },
    {
      id: 'dtc.clear',
      name: 'Clear fault memory',
      operation: 'clear-dtc',
      requiredCapabilities: ['clear-dtc'],
      description: 'Clear the fault memory after explicit confirmation and safety check.',
      canExecute: (context) => {
        if (!context.connected) return { ok: false, reason: 'no vehicle connection' };
        if (!context.ecu) return { ok: false, reason: 'no ECU selected' };
        if (context.ecu.sessionType === 0x01) return { ok: false, reason: 'ECU is in the default session — writes require an extended session' };
        return { ok: true };
      },
    },
    {
      id: 'did.read',
      name: 'Read data',
      operation: 'read',
      requiredCapabilities: ['read-did'],
      description: 'Read a Data Identifier from the ECU.',
      canExecute: (context) =>
        !context.connected
          ? { ok: false, reason: 'no vehicle connection' }
          : context.ecu === undefined
            ? { ok: false, reason: 'no ECU selected' }
            : { ok: true },
    },
    {
      id: 'did.write',
      name: 'Write data',
      operation: 'write-did',
      requiredCapabilities: ['write-did'],
      description: 'Write a Data Identifier (backup + confirmation required).',
      canExecute: (context) => {
        if (!context.connected) return { ok: false, reason: 'no vehicle connection' };
        if (!context.ecu) return { ok: false, reason: 'no ECU selected' };
        if (context.ecu.sessionType === 0x01) return { ok: false, reason: 'ECU is in the default session — writes require an extended session' };
        return { ok: true };
      },
    },
    {
      id: 'routine.run',
      name: 'Run routine',
      operation: 'routine',
      requiredCapabilities: ['routine-control'],
      description: 'Start/stop an ECU routine defined by the package.',
      canExecute: (context) =>
        !context.connected
          ? { ok: false, reason: 'no vehicle connection' }
          : context.ecu === undefined
            ? { ok: false, reason: 'no ECU selected' }
            : { ok: true },
    },
  ];
}
