package com.geekyacedigitalhub.froshmessaging

import android.Manifest
import android.content.pm.PackageManager
import android.telephony.SmsManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshMessagingModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FroshMessaging")
    Function("getPermissionStatus") {
      val context = appContext.reactContext ?: return@Function "unsupported"
      if (context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED) "available" else "permission_required"
    }
    AsyncFunction("requestPermission") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED) return@AsyncFunction true
      appContext.permissions?.askForPermission(this@FroshMessagingModule, Manifest.permission.SEND_SMS)
      false
    }
    Function("send") { phoneNumber: String, message: String ->
      val context = appContext.reactContext ?: return@Function mapOf("accepted" to false, "message" to "Android context is unavailable.")
      if (context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) return@Function mapOf("accepted" to false, "message" to "SMS permission is required.")
      if (phoneNumber.isBlank() || message.isBlank()) return@Function mapOf("accepted" to false, "message" to "A phone number and message are required.")
      return@Function try {
        SmsManager.getDefault().sendTextMessage(phoneNumber, null, message, null, null)
        mapOf("accepted" to true, "message" to "Message sent.")
      } catch (error: Exception) {
        mapOf("accepted" to false, "message" to (error.message ?: "Unable to send SMS."))
      }
    }
  }
}
