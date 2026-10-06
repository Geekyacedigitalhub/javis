package com.geekyacedigitalhub.froshnotifications

import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshNotificationsModule : Module() {
  private fun isEnabled(): Boolean {
    val context = appContext.reactContext ?: return false
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
    return enabled.split(":").any { it == context.packageName }
  }

  override fun definition() = ModuleDefinition {
    Name("FroshNotifications")

    Function("getPermissionStatus") {
      if (isEnabled()) "available" else "permission_required"
    }

    Function("openSettings") {
      val context = appContext.reactContext ?: return@Function false
      context.startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      })
      true
    }

    Function("getRecent") {
      FroshNotificationStore.list()
    }

    Function("reply") { notificationId: String, message: String ->
      if (notificationId.isBlank() || notificationId.length > 512 || message.isBlank() || message.length > 8000 || message.any { it.code < 0x20 || it.code == 0x7f }) {
        return@Function mapOf("accepted" to false, "message" to "Notification ID or reply text is invalid.")
      }
      val sent = FroshNotificationStore.reply(notificationId, message)
      mapOf(
        "accepted" to sent,
        "message" to if (sent) "Reply action sent." else "This notification no longer has a usable reply action."
      )
    }
  }
}