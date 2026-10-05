package com.geekyacedigitalhub.froshnotifications

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

object FroshNotificationStore {
  private val items = ArrayDeque<Map<String, Any?>>()
  private const val MAX_ITEMS = 100

  @Synchronized
  fun add(item: Map<String, Any?>) {
    items.addFirst(item)
    while (items.size > MAX_ITEMS) items.removeLast()
  }

  @Synchronized
  fun list(): List<Map<String, Any?>> = items.toList()
}

class FroshNotificationListenerService : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val extras = sbn.notification.extras
    FroshNotificationStore.add(
      mapOf(
        "id" to sbn.key,
        "packageName" to sbn.packageName,
        "title" to extras.getString(Notification.EXTRA_TITLE),
        "text" to extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
        "receivedAt" to System.currentTimeMillis(),
        "category" to sbn.notification.category,
        "canReply" to (sbn.notification.actions?.any { action ->
          action.remoteInputs?.isNotEmpty() == true
        } == true),
      ),
    )
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification) {}
}
