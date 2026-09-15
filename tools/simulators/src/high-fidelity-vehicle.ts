import { type DefinitionPackage, highFidelityPackage } from "@vdp/definitions";
import type { ServerDid } from "@vdp/protocols-uds";
import { type Logger, createLogger } from "@vdp/shared";
import { type VirtualEcu, VirtualVehicle, type VirtualVehicleOptions } from "./virtual-vehicle.js";

export type IgnitionState = "lock" | "off" | "acc" | "on" | "start";

export interface HighFidelityVehicleOptions extends VirtualVehicleOptions {
  initialIgnition?: IgnitionState;
  initialBatteryVoltage?: number;
  initialIdleSpeed?: number;
}

export class HighFidelityVehicle extends VirtualVehicle {
  private currentIgnition: IgnitionState = "on";
  private currentBatteryVoltage = 12.6;
  private currentIdleSpeedAdaptation = 800; // RPM
  private readonly bcmCodingData = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  private readonly ecuActiveMap = new Map<string, boolean>();
  private gatewayRoutingMode = 0; // 0=normal, 1=degraded, 2=offline
  private readonly hifiLog: Logger;

  constructor(options: HighFidelityVehicleOptions = {}) {
    const pkg: DefinitionPackage = options.definitions ?? highFidelityPackage;
    super({
      ...options,
      definitions: pkg,
    });
    this.hifiLog = (options.logger ?? createLogger("simulator", { level: "WARN" })).child("hifi");
    this.currentIgnition = options.initialIgnition ?? "on";
    this.currentBatteryVoltage = options.initialBatteryVoltage ?? 12.6;
    this.currentIdleSpeedAdaptation = options.initialIdleSpeed ?? 800;

    for (const ecu of this.ecus) {
      this.ecuActiveMap.set(ecu.definition.id, true);
    }

    this.configureSpecialDids();
  }

  /** Current ignition switch position. */
  get ignition(): IgnitionState {
    return this.currentIgnition;
  }

  /** Current battery supply voltage. */
  get batteryVoltage(): number {
    return this.currentBatteryVoltage;
  }

  /** BCM coding memory (DID 0x0200). */
  get bcmCoding(): Uint8Array {
    return new Uint8Array(this.bcmCodingData);
  }

  /** Engine idle speed target adaptation (DID 0x2100). */
  get idleSpeedAdaptation(): number {
    return this.currentIdleSpeedAdaptation;
  }

  /** Set ignition switch state and propagate effects to vehicle modules. */
  setIgnition(state: IgnitionState): void {
    this.currentIgnition = state;
    this.hifiLog.info("ignition state changed", { state });

    if (state === "start") {
      // Cranking voltage sag
      this.currentBatteryVoltage = 10.4;
    } else if (state === "on") {
      // Normal running voltage
      this.currentBatteryVoltage = 14.1;
    } else {
      // Resting key-off battery voltage
      this.currentBatteryVoltage = 12.6;
    }
  }

  /** Set battery voltage. Triggers BCM B1001 when under-voltage (< 11.5 V). */
  setBatteryVoltage(volts: number): void {
    this.currentBatteryVoltage = volts;
    const bcm = this.ecu("bcm");
    if (bcm) {
      if (volts < 11.5) {
        bcm.server.setDtcStatus("B1001", 0x2f); // Active fault
      } else {
        bcm.server.setDtcStatus("B1001", 0x00); // Cleared
      }
    }
  }

  /**
   * Simulate an ECU dropping off the bus (e.g. disconnected, crashed or unpowered).
   * Gateway and interdependent ECUs raise corresponding communication DTCs (U01xx).
   */
  setEcuOnline(ecuId: string, online: boolean): void {
    this.ecuActiveMap.set(ecuId, online);
    const target = this.ecu(ecuId);
    if (!target) return;

    if (!online) {
      target.server.stop();
      this.hifiLog.warn("ECU went offline", { ecuId });
      // Gateway detects node missing
      const gateway = this.ecu("gateway");
      if (gateway) {
        switch (ecuId) {
          case "engine":
            gateway.server.setDtcStatus("U0100", 0x2f);
            break;
          case "transmission":
            gateway.server.setDtcStatus("U0101", 0x2f);
            break;
          case "abs":
            gateway.server.setDtcStatus("U0121", 0x2f);
            // Engine also monitors ABS
            this.ecu("engine")?.server.setDtcStatus("U0121", 0x2f);
            break;
          case "bcm":
            gateway.server.setDtcStatus("U0140", 0x2f);
            break;
        }
      }
    } else {
      target.server.start();
      this.hifiLog.info("ECU returned online", { ecuId });
    }
  }

  isEcuOnline(ecuId: string): boolean {
    return this.ecuActiveMap.get(ecuId) ?? false;
  }

  private configureSpecialDids(): void {
    // 1. Configure BCM DIDs
    const bcm = this.ecu("bcm");
    if (bcm) {
      // DID 0x2001: Battery voltage (uint16, 0.01 V/bit)
      this.registerServerDid(bcm, {
        did: 0x2001,
        value: () => {
          const raw = Math.round(this.currentBatteryVoltage * 100);
          return new Uint8Array([(raw >> 8) & 0xff, raw & 0xff]);
        },
      });

      // DID 0x2002: Ignition state (uint8)
      this.registerServerDid(bcm, {
        did: 0x2002,
        value: () => {
          const code =
            this.currentIgnition === "lock"
              ? 0
              : this.currentIgnition === "off"
                ? 1
                : this.currentIgnition === "acc"
                  ? 2
                  : this.currentIgnition === "on"
                    ? 3
                    : 4;
          return new Uint8Array([code]);
        },
      });

      // DID 0x0200: BCM Coding block (4 bytes, writable)
      this.registerServerDid(bcm, {
        did: 0x0200,
        value: () => new Uint8Array(this.bcmCodingData),
        writable: true,
        write: (payload: Uint8Array) => {
          for (let i = 0; i < Math.min(payload.length, this.bcmCodingData.length); i++) {
            this.bcmCodingData[i] = payload[i] ?? 0;
          }
        },
      });
    }

    // 2. Configure Engine Adaptation DID (0x2100)
    const engine = this.ecu("engine");
    if (engine) {
      this.registerServerDid(engine, {
        did: 0x2100,
        value: () => {
          const val = this.currentIdleSpeedAdaptation;
          return new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
        },
        writable: true,
        write: (payload: Uint8Array) => {
          if (payload.length >= 2) {
            const val = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
            if (val >= 600 && val <= 900) {
              this.currentIdleSpeedAdaptation = val;
            }
          }
        },
      });
    }

    // 3. Configure Gateway DIDs
    const gateway = this.ecu("gateway");
    if (gateway) {
      this.registerServerDid(gateway, {
        did: 0x0100,
        value: () => new Uint8Array([this.gatewayRoutingMode]),
      });
      this.registerServerDid(gateway, {
        did: 0x0101,
        value: () => new Uint8Array([this.currentIgnition === "lock" ? 0 : 1]),
      });
    }
  }

  private registerServerDid(
    ecu: VirtualEcu,
    didDef: ServerDid & { write?: (data: Uint8Array) => void },
  ): void {
    // Replaces or appends DID handler on ECU UdsServer
    const server = ecu.server as unknown as { dids?: Map<number, ServerDid> };
    if (server.dids instanceof Map) {
      server.dids.set(didDef.did, didDef);
    }
  }
}
