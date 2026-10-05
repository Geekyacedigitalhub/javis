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
