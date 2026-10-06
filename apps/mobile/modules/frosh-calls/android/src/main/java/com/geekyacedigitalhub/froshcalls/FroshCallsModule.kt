package com.geekyacedigitalhub.froshcalls

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshCallsModule : Module() {
  private companion object {
    const val MAX_PHONE_NUMBER_LENGTH = 512
  }

  private fun validNumber(number: String): Boolean =
    number.isNotBlank() &&
      number.length <= MAX_PHONE_NUMBER_LENGTH &&
      !number.any { it.code < 0x20 || it.code == 0x7f }

  override fun definition() = ModuleDefinition {
    Name("FroshCalls")
    Function("getPermissionStatus") {
      val context = appContext.reactContext ?: return@Function "unavailable"
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) "available" else "permission_required"
    }
    Function("openDialer") { number: String? ->
      val context = appContext.reactContext ?: return@Function mapOf("accepted" to false, "message" to "Android context unavailable.")
      if (number != null && number.length > MAX_PHONE_NUMBER_LENGTH) return@Function mapOf("accepted" to false, "message" to "Phone number is too long.")
      if (number != null && !validNumber(number)) return@Function mapOf("accepted" to false, "message" to "Phone number is invalid.")
      val uri = if (number.isNullOrBlank()) Uri.parse("tel:") else Uri.parse("tel:" + Uri.encode(number))
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
      if (!validNumber(number)) return@Function mapOf("accepted" to false, "message" to "A valid phone number is required.")
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED)
        return@Function mapOf("accepted" to false, "message" to "CALL_PHONE permission is required before placing a direct call.")
      context.startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      mapOf("accepted" to true, "message" to "Direct call started.")
    }
  }
}