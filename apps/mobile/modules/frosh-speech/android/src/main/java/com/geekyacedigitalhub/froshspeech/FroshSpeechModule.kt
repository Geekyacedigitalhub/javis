package com.geekyacedigitalhub.froshspeech

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val MAX_TRANSCRIPT_LENGTH = 4_000
private const val RECORD_AUDIO_REQUEST_CODE = 4821

class FroshSpeechModule : Module() {
  private var recognizer: SpeechRecognizer? = null
  private var listening = false

  private fun audioPermissionGranted(): Boolean {
    val context = appContext.reactContext ?: return false
    return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
  }

  private fun cleanTranscript(value: String?): String? = value
    ?.replace(Regex("[\\u0000-\\u001f\\u007f]"), " ")
    ?.replace(Regex("\\s+"), " ")
    ?.trim()
    ?.take(MAX_TRANSCRIPT_LENGTH)
    ?.takeIf { it.isNotEmpty() }

  private fun validLanguage(value: String?): String? {
    val language = value?.trim().orEmpty().ifEmpty { "en-US" }
    return language.takeIf { it.length <= 35 && Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$").matches(it) }
  }

  private fun errorMessage(code: Int): String = when (code) {
    SpeechRecognizer.ERROR_AUDIO -> "Android could not read microphone audio."
    SpeechRecognizer.ERROR_CLIENT -> "Speech recognition was cancelled."
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required for voice input."
    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Android's speech service is unavailable. Check your connection or speech settings."
    SpeechRecognizer.ERROR_NO_MATCH -> "FROSH could not understand that. Try again."
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Android's speech recognizer is busy. Try again shortly."
    SpeechRecognizer.ERROR_SERVER -> "Android's speech service returned an error."
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was detected."
    else -> "Android speech recognition failed."
  }

  private fun sendTranscript(type: String, transcript: String) {
    sendEvent(type, mapOf("transcript" to transcript.take(MAX_TRANSCRIPT_LENGTH)))
  }

  private fun releaseRecognizer() {
    recognizer?.cancel()
    recognizer?.destroy()
    recognizer = null
    listening = false
  }

  private fun createRecognizer(): SpeechRecognizer? {
    val activity = appContext.currentActivity ?: return null
    val context = appContext.reactContext ?: return null
    if (!SpeechRecognizer.isRecognitionAvailable(context)) return null

    releaseRecognizer()
    return SpeechRecognizer.createSpeechRecognizer(activity).also { speechRecognizer ->
      speechRecognizer.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
          sendEvent("state", mapOf("listening" to true))
        }

        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit

        override fun onError(error: Int) {
          listening = false
          sendEvent("state", mapOf("listening" to false))
          sendEvent("error", mapOf("message" to errorMessage(error)))
        }

        override fun onResults(results: Bundle?) {
          listening = false
          val transcript = cleanTranscript(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
          sendEvent("state", mapOf("listening" to false))
          if (transcript != null) sendTranscript("result", transcript)
          else sendEvent("error", mapOf("message" to "FROSH could not understand that. Try again."))
        }

        override fun onPartialResults(partialResults: Bundle?) {
          val transcript = cleanTranscript(partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
          if (transcript != null) sendTranscript("partial", transcript)
        }

        override fun onEvent(eventType: Int, params: Bundle?) = Unit
      })
    }
  }

  override fun definition() = ModuleDefinition {
    Name("FroshSpeech")
    Events("partial", "result", "error", "state")

    Function("getStatus") {
      val context = appContext.reactContext
      mapOf(
        "available" to (context != null && SpeechRecognizer.isRecognitionAvailable(context)),
        "permission" to if (audioPermissionGranted()) "granted" else "required",
        "listening" to listening,
      )
    }

    Function("requestPermission") {
      val activity = appContext.currentActivity ?: return@Function false
      activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), RECORD_AUDIO_REQUEST_CODE)
      true
    }

    Function("start") { requestedLanguage: String? ->
      val context = appContext.reactContext ?: return@Function mapOf("accepted" to false, "message" to "Android context unavailable.")
      val language = validLanguage(requestedLanguage)
        ?: return@Function mapOf("accepted" to false, "message" to "Speech language is invalid.")
      if (!audioPermissionGranted()) {
        return@Function mapOf("accepted" to false, "message" to "Microphone permission is required for voice input.")
      }
      if (!SpeechRecognizer.isRecognitionAvailable(context)) {
        return@Function mapOf("accepted" to false, "message" to "Android speech recognition is unavailable on this device.")
      }
      val activity = appContext.currentActivity
        ?: return@Function mapOf("accepted" to false, "message" to "Android activity unavailable.")

      activity.runOnUiThread {
        try {
          recognizer = createRecognizer()
          val current = recognizer ?: run {
            sendEvent("error", mapOf("message" to "Android speech recognition is unavailable on this device."))
            return@runOnUiThread
          }
          val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
          }
          listening = true
          current.startListening(intent)
        } catch (_: Exception) {
          listening = false
          sendEvent("state", mapOf("listening" to false))
          sendEvent("error", mapOf("message" to "Android could not start speech recognition."))
        }
      }
      mapOf("accepted" to true, "message" to "Listening for a voice command.")
    }

    Function("stop") {
      if (!listening) return@Function mapOf("accepted" to false, "message" to "FROSH is not listening.")
      recognizer?.stopListening()
      mapOf("accepted" to true, "message" to "Processing voice command.")
    }

    Function("cancel") {
      if (!listening) return@Function mapOf("accepted" to false, "message" to "FROSH is not listening.")
      recognizer?.cancel()
      listening = false
      sendEvent("state", mapOf("listening" to false))
      mapOf("accepted" to true, "message" to "Voice input cancelled.")
    }

    OnDestroy {
      releaseRecognizer()
    }
  }
}
