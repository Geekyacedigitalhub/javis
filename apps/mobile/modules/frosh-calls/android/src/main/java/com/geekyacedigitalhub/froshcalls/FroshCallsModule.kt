package com.geekyacedigitalhub.froshcalls

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshCallsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FroshCalls")
    Function("getPermissionStatus") {
      val context = appContext.reactContext ?: return@Function "unavailable"
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) "available" else "permission_required"
    }
    Function("openDialer") { number: String? ->
      val context = appContext.reactContext ?: return@Function mapOf("accepted" to false, "message" to "Android context unavailable.")
      val uri = if (number.isNullOrBlank()) Uri.parse("tel:") else Uri.parse("tel:"+Uri.encode(number))
      context.startActivity(Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      mapOf("accepted" to true, "message" to "Opened the phone dialer.")
    }
    Function("requestPermission") {
      val activity = appContext.currentActivity ?: return@Function false
      activity.requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), 4817)
      true
    }
    Function("directCall") { number: String ->
      val context = appContext.reactContext ?: return@Function mapOf("accepted" to false, "message" to "Android context unavailable.")
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED)
        return@Function mapOf("accepted" to false, "message" to "CALL_PHONE permission is required before placing a direct call.")
      context.startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:"+Uri.encode(number))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      mapOf("accepted" to true, "message" to "Direct call started.")
    }
  }
}