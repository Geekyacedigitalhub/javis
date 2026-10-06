package com.geekyacedigitalhub.froshcontacts

import android.Manifest
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshContactsModule : Module() {
  private companion object {
    const val MAX_QUERY_LENGTH = 512
    const val MAX_RESULTS = 20
    const val MAX_PHONES_PER_CONTACT = 8
  }

  private fun hasAccess(): Boolean {
    val context = appContext.reactContext ?: return false
    return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED
  }

  override fun definition() = ModuleDefinition {
    Name("FroshContacts")
    Function("getPermissionStatus") { if (hasAccess()) "available" else "permission_required" }
    Function("requestPermission") {
      val activity = appContext.currentActivity ?: return@Function false
      activity.requestPermissions(arrayOf(Manifest.permission.READ_CONTACTS), 4818)
      true
    }
    Function("search") { query: String ->
      if (!hasAccess()) return@Function emptyList<Map<String, Any?>>()
      if (query.length > MAX_QUERY_LENGTH || query.any { it.code < 0x20 || it.code == 0x7f }) {
        return@Function emptyList<Map<String, Any?>>()
      }
      val context = appContext.reactContext ?: return@Function emptyList<Map<String, Any?>>()
      val trimmed = query.trim()
      if (trimmed.isEmpty()) return@Function emptyList<Map<String, Any?>>()
      val results = mutableListOf<Map<String, Any?>>()
      val projection = arrayOf(
        ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
        ContactsContract.CommonDataKinds.Phone.NUMBER,
        ContactsContract.CommonDataKinds.Phone.TYPE
      )
      context.contentResolver.query(
        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
        projection,
        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ? ESCAPE '\\'",
        arrayOf("%" + trimmed.replace("%", "\%").replace("_", "\_") + "%"),
        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
      )?.use { cursor ->
        val idIndex = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
        val nameIndex = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
        val numberIndex = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
        val typeIndex = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.TYPE)
        val grouped = linkedMapOf<String, MutableMap<String, Any?>>()
        while (cursor.moveToNext() && grouped.size < MAX_RESULTS) {
          val id = cursor.getString(idIndex)
          val contact = grouped.getOrPut(id) {
            mutableMapOf("id" to id, "name" to cursor.getString(nameIndex), "phones" to mutableListOf<Map<String, Any?>>())
          }
          @Suppress("UNCHECKED_CAST")
          val phones = contact["phones"] as MutableList<Map<String, Any?>>
          if (phones.size < MAX_PHONES_PER_CONTACT) {
            phones.add(mapOf(
              "label" to ContactsContract.CommonDataKinds.Phone.getTypeLabel(context.resources, cursor.getInt(typeIndex), "").toString(),
              "number" to cursor.getString(numberIndex)
            ))
          }
        }
        results.addAll(grouped.values)
      }
      results.take(MAX_RESULTS)
    }
  }
}