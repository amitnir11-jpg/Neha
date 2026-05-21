package com.daksh.inventory.scanner

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.android.FlutterActivity
import io.flutter.plugin.common.MethodChannel

class MainActivity: FlutterActivity() {
    private var toneGenerator: ToneGenerator? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "daksh/scan_feedback"
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "playSuccessFeedback" -> {
                    Log.d("SCAN_FEEDBACK", "Scan success received")
                    playBeep()
                    vibrate()
                    result.success(true)
                }
                "playBeep" -> {
                    playBeep()
                    result.success(true)
                }
                "playWarningSound" -> {
                    playWarningSound()
                    result.success(true)
                }
                "vibrate" -> {
                    vibrate()
                    result.success(true)
                }
                "warningVibration" -> {
                    warningVibration()
                    result.success(true)
                }
                "warningFeedback" -> {
                    playWarningSound()
                    warningVibration()
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
    }

    override fun onDestroy() {
        toneGenerator?.release()
        toneGenerator = null
        super.onDestroy()
    }

    private fun playBeep() {
        Log.d("SCAN_FEEDBACK", "Beep called")
        try {
            if (toneGenerator == null) {
                toneGenerator = ToneGenerator(AudioManager.STREAM_MUSIC, 100)
            }
            toneGenerator?.startTone(
                ToneGenerator.TONE_PROP_BEEP,
                150
            )
        } catch (_: Throwable) {
            toneGenerator?.release()
            toneGenerator = null
        }
    }

    private fun playWarningSound() {
        Log.d("SCAN_FEEDBACK", "Warning sound called")
        try {
            if (toneGenerator == null) {
                toneGenerator = ToneGenerator(AudioManager.STREAM_MUSIC, 100)
            }
            toneGenerator?.startTone(ToneGenerator.TONE_PROP_NACK, 150)
        } catch (_: Throwable) {
            toneGenerator?.release()
            toneGenerator = null
        }
    }

    private fun vibrate() {
        Log.d("SCAN_FEEDBACK", "Vibration called")
        vibrateFor(120)
    }

    private fun warningVibration() {
        Log.d("SCAN_FEEDBACK", "Vibration called")
        vibrateFor(70)
    }

    private fun vibrateFor(durationMs: Long) {
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(durationMs)
            }
        } catch (_: Throwable) {
        }
    }
}
