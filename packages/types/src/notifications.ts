export interface FroshNotification {
  id: string;
  packageName: string;
  appName?: string;
  title?: string;
  text?: string;
  receivedAt: string;
  category?: string;
  canReply?: boolean;
}

export interface FroshNotificationCapability {
  available: boolean;
  message?: string;
}

export interface FroshNotificationReplyRequest {
  notificationId: string;
  message: string;
}

export interface FroshNotificationReplyResult {
  accepted: boolean;
  message: string;
}

export interface FroshUnifiedMessage {
  id: string;
  provider: string;
  packageName: string;
  appName?: string;
  sender?: string;
  text?: string;
  receivedAt: string;
  canReply: boolean;
  notificationId: string;
}

export interface FroshUnifiedInbox {
  messages: FroshUnifiedMessage[];
}

export type FroshMessagePriority = "low" | "normal" | "high" | "urgent";

export interface FroshMessageInsight {
  messageId: string;
  provider: string;
  sender?: string;
  summary: string;
  priority: FroshMessagePriority;
  needsReply: boolean;
  replyReason?: string;
  receivedAt: string;
}

export interface FroshMessageDigest {
  total: number;
  needsReply: number;
  urgent: number;
  insights: FroshMessageInsight[];
}


export type FroshMessagePriority = "low" | "normal" | "high" | "urgent";

export interface FroshMessageInsight extends FroshUnifiedMessage {
  priority: FroshMessagePriority;
  likelyNeedsReply: boolean;
  reason?: string;
}

export interface FroshMessagingSummary {
  total: number;
  needsReply: number;
  urgent: number;
  byProvider: Record<string, number>;
  highlights: FroshMessageInsight[];
}
