package com.geekyacedigitalhub.froshmedia

import android.content.Context
import android.media.AudioManager
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.os.Build
import android.content.Intent
import android.provider.Settings
import androidx.annotation.RequiresApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FroshMediaModule : Module() {
  private fun controllers(): List<MediaController> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return emptyList()
    val context = appContext.reactContext ?: return emptyList()
    val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
    return try {
      manager.getActiveSessions(null)
    } catch (_: SecurityException) {
      emptyList()
    }
  }

  @RequiresApi(Build.VERSION_CODES.LOLLIPOP)
  override fun definition() = ModuleDefinition {
    Name("FroshMedia")

    Function("openMediaAccessSettings") {
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }

    Function("getPermissionStatus") {
      val context = appContext.reactContext ?: return@Function "unavailable"
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return@Function "unsupported"
      val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
      try {
        manager.getActiveSessions(null)
        "available"
      } catch (_: SecurityException) {
        "permission_required"
      }
    }

    AsyncFunction("getState") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        return@AsyncFunction mapOf("available" to false, "message" to "Android media sessions are unsupported.")
      }
      val controller = controllers().firstOrNull()
        ?: return@AsyncFunction mapOf("available" to false, "message" to "No active media session.")

      val metadata = controller.metadata
      val state = controller.playbackState
      mapOf(
        "available" to true,
        "isPlaying" to (state?.state == android.media.session.PlaybackState.STATE_PLAYING),
        "title" to metadata?.getString(android.media.MediaMetadata.METADATA_KEY_TITLE),
        "artist" to metadata?.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST),
        "album" to metadata?.getString(android.media.MediaMetadata.METADATA_KEY_ALBUM),
        "durationMs" to (metadata?.getLong(android.media.MediaMetadata.METADATA_KEY_DURATION) ?: 0L),
        "positionMs" to (state?.position ?: 0L)
      )
    }

    AsyncFunction("control") { action: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        return@AsyncFunction mapOf("accepted" to false, "message" to "Android media sessions are unsupported.")
      }

      val controller = controllers().firstOrNull()
        ?: return@AsyncFunction mapOf("accepted" to false, "message" to "No active media session.")

      val transport = controller.transportControls
      when (action) {
        "play" -> transport.play()
        "pause" -> transport.pause()
        "toggle" -> {
          val playing = controller.playbackState?.state == android.media.session.PlaybackState.STATE_PLAYING
          if (playing) transport.pause() else transport.play()
        }
        "next" -> transport.skipToNext()
        "previous" -> transport.skipToPrevious()
        "stop" -> transport.stop()
        else -> return@AsyncFunction mapOf("accepted" to false, "message" to "Unsupported media action.")
      }

      mapOf("accepted" to true, "message" to "Media action sent to the active media session.")
    }

    AsyncFunction("volume") { direction: String ->
      val context = appContext.reactContext ?: return@AsyncFunction mapOf("accepted" to false, "message" to "Android context unavailable.")
      val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val adjustment = if (direction == "up") AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
      audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, adjustment, 0)
      mapOf("accepted" to true, "message" to "Media volume adjusted.")
    }
  }
}
