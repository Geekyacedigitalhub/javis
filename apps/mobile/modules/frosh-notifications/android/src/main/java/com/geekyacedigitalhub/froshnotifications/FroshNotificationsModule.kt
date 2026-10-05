package com.geekyacedigitalhub.froshnotifications

import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.text.TextUtils
import androidx.annotation.RequiresApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshNotificationsModule : Module() {
  private fun isEnabled(): Boolean {
    val context = appContext.reactContext ?: return false
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
    return enabled.split(":").any { it.contains(context.packageName) }
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
  }
}
