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
