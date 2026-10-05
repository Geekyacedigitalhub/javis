package com.geekyacedigitalhub.froshapps

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshAppsModule : Module() {
  private fun packageManager(): PackageManager? = appContext.reactContext?.packageManager

  private fun launchableApps(): List<ApplicationInfo> {
    val pm = packageManager() ?: return emptyList()
    val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
      .map { it.activityInfo.applicationInfo }
      .distinctBy { it.packageName }
  }

  override fun definition() = ModuleDefinition {
    Name("FroshApps")

    Function("listApps") {
      val pm = packageManager() ?: return@Function emptyList<Map<String, String>>()
      launchableApps()
        .sortedBy { pm.getApplicationLabel(it).toString().lowercase() }
        .map {
          mapOf(
            "packageName" to it.packageName,
            "name" to pm.getApplicationLabel(it).toString()
          )
        }
    }


    Function("listMessagingApps") {
      val pm = packageManager() ?: return@Function emptyList<Map<String, String>>()
      val known = mapOf(
        "com.whatsapp" to "whatsapp",
        "org.telegram.messenger" to "telegram",
        "com.facebook.orca" to "messenger",
        "com.instagram.android" to "instagram",
        "com.discord" to "discord",
        "com.google.android.apps.messaging" to "sms"
      )
      launchableApps()
        .filter { known.containsKey(it.packageName) }
        .map {
          mapOf(
            "provider" to known[it.packageName]!!,
            "packageName" to it.packageName,
            "name" to pm.getApplicationLabel(it).toString()
          )
        }
    }

    Function("openApp") { packageName: String ->
      val pm = packageManager() ?: return@Function mapOf(
        "accepted" to false,
        "message" to "Android package manager unavailable."
      )
      val target = launchableApps().firstOrNull { it.packageName == packageName }
        ?: return@Function mapOf(
          "accepted" to false,
          "message" to "That app is not available as a launchable installed app."
        )

      val intent = pm.getLaunchIntentForPackage(target.packageName)
        ?: return@Function mapOf(
          "accepted" to false,
          "message" to "Android could not find a launch intent for that app."
        )

      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      appContext.reactContext?.startActivity(intent)

      mapOf(
        "accepted" to true,
        "message" to "App launched.",
        "packageName" to target.packageName
      )
    }
  }
}
