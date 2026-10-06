package com.geekyacedigitalhub.froshmessaging

import android.Manifest
import android.content.pm.PackageManager
import android.telephony.SmsManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshMessagingModule : Module() {
  private companion object {
    const val MAX_PHONE_NUMBER_LENGTH = 512
    const val MAX_MESSAGE_LENGTH = 8000
  }

  private fun validText(value: String, maxLength: Int): Boolean =
    value.isNotBlank() &&
      value.length <= maxLength &&
      !value.any { it.code < 0x20 || it.code == 0x7f }

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
      if (!validText(phoneNumber, MAX_PHONE_NUMBER_LENGTH) || !validText(message, MAX_MESSAGE_LENGTH)) {
        return@Function mapOf("accepted" to false, "message" to "Phone number or message is invalid or too large.")
      }
      if (context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) return@Function mapOf("accepted" to false, "message" to "SMS permission is required.")
      return@Function try {
        SmsManager.getDefault().sendTextMessage(phoneNumber, null, message, null, null)
        mapOf("accepted" to true, "message" to "Message sent.")
      } catch (error: Exception) {
        mapOf("accepted" to false, "message" to (error.message ?: "Unable to send SMS."))
      }
    }
  }
}