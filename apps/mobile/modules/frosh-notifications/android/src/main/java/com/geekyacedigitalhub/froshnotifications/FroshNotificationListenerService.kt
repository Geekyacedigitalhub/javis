package com.geekyacedigitalhub.froshnotifications

import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

data class FroshReplyTarget(
  val action: Notification.Action,
  val remoteInputKey: String,
  val notificationKey: String,
)

object FroshNotificationStore {
  private val items = ArrayDeque<Map<String, Any?>>()
  private val replyTargets = mutableMapOf<String, FroshReplyTarget>()
  private const val MAX_ITEMS = 100

  @Synchronized
  fun add(item: Map<String, Any?>, replyTarget: FroshReplyTarget?) {
    items.addFirst(item)
    while (items.size > MAX_ITEMS) items.removeLast()
    if (replyTarget != null) replyTargets[item["id"] as String] = replyTarget
    while (replyTargets.size > MAX_ITEMS) {
      replyTargets.remove(replyTargets.keys.first())
    }
  }

  @Synchronized
  fun list(): List<Map<String, Any?>> = items.toList()

  @Synchronized
  fun reply(notificationId: String, message: String): Boolean {
    val target = replyTargets[notificationId] ?: return false
    return try {
      val fillIn = Intent()
      val results = Bundle()
      results.putCharSequence(target.remoteInputKey, message)
      android.app.RemoteInput.addResultsToIntent(arrayOf(target.action.remoteInputs!!.first()), fillIn, results)
      target.action.actionIntent.send(null, 0, fillIn)
      true
    } catch (_: Exception) {
      false
    }
  }
}

class FroshNotificationListenerService : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val extras = sbn.notification.extras
    val replyAction = sbn.notification.actions?.firstOrNull { action ->
      action.remoteInputs?.isNotEmpty() == true
    }
    val remoteInput = replyAction?.remoteInputs?.firstOrNull()

    FroshNotificationStore.add(
      mapOf(
        "id" to sbn.key,
        "packageName" to sbn.packageName,
        "title" to extras.getString(Notification.EXTRA_TITLE),
        "text" to extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
        "receivedAt" to System.currentTimeMillis(),
        "category" to sbn.notification.category,
        "canReply" to (replyAction != null),
      ),
      if (replyAction != null && remoteInput != null) {
        FroshReplyTarget(replyAction, remoteInput.resultKey, sbn.key)
      } else null,
    )
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification) {}
}
