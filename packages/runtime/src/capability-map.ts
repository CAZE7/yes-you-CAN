/**
 * ISO 14229-1 service → capability bridge.
 *
 * This mapping lives in the runtime layer on purpose: the domain defines the
 * capability *vocabulary* but must not know protocols (target architecture
 * §3), while the protocols layer must not know the domain. The runtime is the
 * composition point where a probed UDS service becomes a domain capability.
 */

import type { DiagnosticCapability } from '@vdp/domain';

/** ISO 14229-1 service id → capability it proves (AGENTS 12 "Supported Services"). */
export const UDS_SERVICE_CAPABILITIES: Readonly<Record<number, DiagnosticCapability>> = {
  0x10: 'session-control',
  0x11: 'ecu-reset',
  0x14: 'clear-dtc',
  0x19: 'read-dtc',
  0x22: 'read-did',
  0x27: 'security-access',
  0x2e: 'write-did',
  0x2f: 'io-control',
  0x31: 'routine-control',
  0x3e: 'tester-present',
};

/**
 * Derive the capability list from the services an ECU positively answers.
 * Capabilities like `coding`, `adaptation` or `flash` are not bound to one
 * service id; definition packages grant them explicitly once those features
 * exist.
 */
export function capabilitiesFromServices(services: readonly number[]): DiagnosticCapability[] {
  const set = new Set<DiagnosticCapability>();
  for (const service of services) {
    const capability = UDS_SERVICE_CAPABILITIES[service];
    if (capability !== undefined) set.add(capability);
  }
  return Array.from(set).sort();
}
