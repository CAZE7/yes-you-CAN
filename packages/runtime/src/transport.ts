/**
 * DoIP transport seam (ISO 13400; AGENTS 5, 36, blueprint: transport is
 * pluggable).
 *
 * `DiagnosticEngine` obtains each ECU's link through an {@link EcuLinkFactory}.
 * On CAN the engine builds an ISO-TP connection itself; this factory is the
 * drop-in for DoIP: one TCP connection per target ECU, UDS payloads wrapped by
 * `DoipTransport`, exposed to the UDS layer as a plain {@link UdsLink} via
 * `createRequestResponseLink`. Nothing above the link changes — the engine,
 * sessions and services are identical for CAN and DoIP.
 */

import { createLogger, type Logger } from '@vdp/shared';
import { createRequestResponseLink } from '@vdp/protocols-uds';
import { DoipTransport, type DoipSocket } from '@vdp/transport-doip';
import type { EcuLinkFactory, OpenedEcuLink } from '@vdp/core';

export interface DoipEcuLinkFactoryOptions {
  /**
   * Opens the transport for one target ECU. Node returns a TLS/plain TCP
   * socket, a browser a WebSocket, a test a fake endpoint — the factory does
   * not care which.
   */
  createSocket: (targetAddress: number) => DoipSocket;
  /** Tester logical address (default 0x0E00, like most external testers). */
  testerAddress?: number;
  /** Require TLS (ISO 13400-2 port 3496) — recommended for productive use. */
  requireTls?: boolean;
  /** Default UDS response timeout in ms, handed to the request/response link. */
  responseTimeoutMs?: number;
  /**
   * Maps the engine's ECU addressing to a DoIP logical address. Defaults to the
   * response identifier, which matches how definition packages address DoIP ECUs.
   */
  logicalAddressFor?: (ecu: { txId: number; rxId: number; extended?: boolean }) => number;
  logger?: Logger;
}

/** The engine's transport seam, implemented for DoIP. */
export class DoipEcuLinkFactory implements EcuLinkFactory {
  private readonly log: Logger;

  constructor(private readonly options: DoipEcuLinkFactoryOptions) {
    this.log = (options.logger ?? createLogger('doip', { level: 'INFO' })).child('doip');
  }

  async open(ecu: { txId: number; rxId: number; extended?: boolean }): Promise<OpenedEcuLink> {
    const targetAddress = this.options.logicalAddressFor?.(ecu) ?? ecu.rxId;
    const transport = new DoipTransport({
      socket: this.options.createSocket(targetAddress),
      targetAddress,
      logger: this.log,
      ...(this.options.testerAddress !== undefined ? { testerAddress: this.options.testerAddress } : {}),
      ...(this.options.requireTls !== undefined ? { requireTls: this.options.requireTls } : {}),
    });
    // Routing activation happens on connect; only then may UDS payloads flow.
    await transport.connect();
    const link = createRequestResponseLink(
      transport,
      this.options.responseTimeoutMs !== undefined ? { defaultTimeoutMs: this.options.responseTimeoutMs, logger: this.log } : { logger: this.log },
    );
    this.log.debug('DoIP link opened', { target: `0x${targetAddress.toString(16)}` });
    return {
      link,
      close: () => {
        void transport.disconnect().catch((error) => {
          this.log.warn('DoIP disconnect failed', {
            target: `0x${targetAddress.toString(16)}`,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    };
  }
}

/** Convenience constructor mirroring the engine's other `create*` helpers. */
export function createDoipEcuLinkFactory(options: DoipEcuLinkFactoryOptions): DoipEcuLinkFactory {
  return new DoipEcuLinkFactory(options);
}
