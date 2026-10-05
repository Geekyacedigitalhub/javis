export type FroshPhoneAction =
  | "open_app"
  | "open_dialer"
  | "call_number"
  | "compose_message"
  | "send_message";

export interface FroshPhoneActionRequest {
  action: FroshPhoneAction;
  value?: string;
  message?: string;
  packageName?: string;
}

export interface FroshPhoneActionResult {
  action: FroshPhoneAction;
  accepted: boolean;
  message: string;
}
