export type FroshMessagingProvider =
  | "sms"
  | "whatsapp"
  | "telegram"
  | "messenger"
  | "instagram"
  | "discord"
  | "other";

export type FroshMessagingSupport = "direct_send" | "notification_reply" | "open_compose" | "unsupported";

export interface FroshMessagingProviderInfo {
  provider: FroshMessagingProvider;
  displayName: string;
  installed?: boolean;
  support: FroshMessagingSupport;
  detail?: string;
}

export interface FroshMessageRequest {
  provider: FroshMessagingProvider;
  recipient: string;
  message: string;
}

export interface FroshMessageResult {
  provider: FroshMessagingProvider;
  accepted: boolean;
  message: string;
  support?: FroshMessagingSupport;
}

export interface FroshMessagingCapability {
  providers: FroshMessagingProviderInfo[];
}
