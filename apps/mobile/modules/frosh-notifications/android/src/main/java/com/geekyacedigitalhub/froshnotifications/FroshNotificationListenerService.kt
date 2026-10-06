package com.geekyacedigitalhub.froshnotifications

import android.app.Notification
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
  private const val MAX_ITEMS = 100
  private const val MAX_TEXT_LENGTH = 512
  private const val MAX_REPLY_LENGTH = 8000
  private val items = ArrayDeque<Map<String, Any?>>()
  private val replyTargets = mutableMapOf<String, FroshReplyTarget>()

  private fun boundedText(value: CharSequence?): String? =
    value?.toString()?.take(MAX_TEXT_LENGTH)

  @Synchronized
  fun add(item: Map<String, Any?>, replyTarget: FroshReplyTarget?) {
    items.addFirst(item)
    while (items.size > MAX_ITEMS) {
      val removed = items.removeLast()
      val removedId = removed["id"] as? String
      if (removedId != null) replyTargets.remove(removedId)
    }
    if (replyTarget != null) replyTargets[item["id"] as String] = replyTarget
  }

  @Synchronized
  fun list(): List<Map<String, Any?>> = items.toList()

  @Synchronized
  fun reply(notificationId: String, message: String): Boolean {
    if (notificationId.length > 512 || message.isBlank() || message.length > MAX_REPLY_LENGTH || message.any { it.code < 0x20 || it.code == 0x7f }) return false
    val target = replyTargets[notificationId] ?: return false
    if (target.notificationKey != notificationId || target.action.remoteInputs.isNullOrEmpty()) return false
    return try {
      val fillIn = Intent()
      val results = Bundle()
      results.putCharSequence(target.remoteInputKey, message)
      android.app.RemoteInput.addResultsToIntent(arrayOf(target.action.remoteInputs.first()), fillIn, results)
      target.action.actionIntent.send(null, 0, fillIn)
      true
    } catch (_: Exception) {
      false
    }
  }
}

class FroshNotificationListenerService : NotificationListenerService() {
  private fun appName(packageName: String): String? = try {
    packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString().take(512)
  } catch (_: Exception) { null }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val extras = sbn.notification.extras
    val replyAction = sbn.notification.actions?.firstOrNull { action ->
      action.remoteInputs?.isNotEmpty() == true
    }
    val remoteInput = replyAction?.remoteInputs?.firstOrNull()

    FroshNotificationStore.add(
      mapOf(
        "id" to sbn.key.take(512),
        "packageName" to sbn.packageName.take(255),
        "appName" to appName(sbn.packageName),
        "title" to boundedText(extras.getString(Notification.EXTRA_TITLE)),
        "text" to boundedText(extras.getCharSequence(Notification.EXTRA_TEXT)),
        "receivedAt" to System.currentTimeMillis(),
        "category" to sbn.notification.category?.take(64),
        "canReply" to (replyAction != null),
      ),
      if (replyAction != null && remoteInput != null) {
        FroshReplyTarget(replyAction, remoteInput.resultKey.take(255), sbn.key.take(512))
      } else null,
    )
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification) {}
}