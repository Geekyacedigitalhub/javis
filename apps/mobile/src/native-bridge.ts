import type { FroshPhoneActionRequest, FroshPhoneActionResult } from "../../../packages/types/src/phone-actions";
import { executePhoneAction } from "./phone-actions";

export async function runNativePhoneAction(
  request: FroshPhoneActionRequest,
): Promise<FroshPhoneActionResult> {
  return executePhoneAction(request);
}
