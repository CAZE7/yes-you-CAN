/**
 * HTTP-side mapping of write operations (ADR 0032).
 *
 * The WritePort lives in `@vdp/runtime`. This module only builds the binding the
 * port needs and projects the result the workbench shows — so `backend.ts` does
 * not grow a second copy of the vehicle-state spread each time a write is added.
 */

import type { WriteBinding } from "@vdp/runtime";
import { formatCanId } from "./trace-view.js";
import type { AdaptationResultView, CodingResultView, EcuView, VehicleStateView } from "./views.js";

export function ecuNameOf(ecus: readonly EcuView[], rxId: number): string {
  return ecus.find((ecu) => ecu.rxId === formatCanId(rxId))?.name ?? `ECU_${formatCanId(rxId)}`;
}

export function writeBindingOf(
  rxId: number,
  ecuName: string,
  vehicleState: VehicleStateView,
): WriteBinding {
  return {
    ecuId: `0x${rxId.toString(16)}`,
    ecuName,
    vehicleState: {
      stationary: vehicleState.stationary,
      ignitionOn: vehicleState.ignitionOn,
      ...(vehicleState.parkingBrake !== undefined
        ? { parkingBrake: vehicleState.parkingBrake }
        : {}),
      ...(vehicleState.batteryVoltage !== undefined
        ? { batteryVoltage: vehicleState.batteryVoltage }
        : {}),
    },
  };
}

export function codingResultViewOf(
  result: {
    ok: boolean;
    reasons: readonly string[];
    warnings: readonly string[];
    transaction: { id: string };
    value?: unknown;
  },
  binding: WriteBinding,
  did: number,
): CodingResultView {
  const originalHex =
    result.value && typeof result.value === "object" && "originalHex" in result.value
      ? String(result.value.originalHex)
      : undefined;
  const writtenHex =
    result.value && typeof result.value === "object" && "writtenHex" in result.value
      ? String(result.value.writtenHex)
      : undefined;
  return {
    ok: result.ok,
    verified: Boolean(
      result.value &&
        typeof result.value === "object" &&
        "verified" in result.value &&
        result.value.verified,
    ),
    ecuId: binding.ecuId,
    did,
    ...(originalHex !== undefined ? { originalHex } : {}),
    ...(writtenHex !== undefined ? { writtenHex } : {}),
    reasons: [...result.reasons],
    warnings: [...result.warnings],
    transactionId: result.transaction.id,
  };
}

export function adaptationResultViewOf(
  result: {
    ok: boolean;
    reasons: readonly string[];
    warnings: readonly string[];
    transaction: { id: string };
    value?: unknown;
  },
  binding: WriteBinding,
  did: number,
): AdaptationResultView {
  const originalValue =
    result.value && typeof result.value === "object" && "originalValue" in result.value
      ? Number(result.value.originalValue)
      : undefined;
  const writtenValue =
    result.value && typeof result.value === "object" && "writtenValue" in result.value
      ? Number(result.value.writtenValue)
      : undefined;
  const unit =
    result.value && typeof result.value === "object" && "unit" in result.value
      ? String(result.value.unit)
      : undefined;
  return {
    ok: result.ok,
    verified: Boolean(
      result.value &&
        typeof result.value === "object" &&
        "verified" in result.value &&
        result.value.verified,
    ),
    ecuId: binding.ecuId,
    did,
    ...(originalValue !== undefined ? { originalValue } : {}),
    ...(writtenValue !== undefined ? { writtenValue } : {}),
    ...(unit !== undefined ? { unit } : {}),
    reasons: [...result.reasons],
    warnings: [...result.warnings],
    transactionId: result.transaction.id,
  };
}
