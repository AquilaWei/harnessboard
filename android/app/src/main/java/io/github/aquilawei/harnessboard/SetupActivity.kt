package io.github.aquilawei.harnessboard

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.browser.customtabs.CustomTabsIntent
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * Sets up which board the app opens: scan the computer's pairing QR or type the board address.
 * The scanner runs in Google Play services, so the app needs no camera permission.
 */
class SetupActivity : Activity() {
    private lateinit var model: SetupModel
    private lateinit var address: EditText
    private lateinit var error: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        model = SetupModel(PreferencesBoardStore(this))
        address = findViewById(R.id.address)
        error = findViewById(R.id.error)

        findViewById<Button>(R.id.scan).setOnClickListener { scan() }
        findViewById<Button>(R.id.connect).setOnClickListener { connect() }
        address.setOnEditorActionListener { _, actionId, _ ->
            (actionId == EditorInfo.IME_ACTION_GO).also { if (it) connect() }
        }
    }

    private fun connect() {
        show(model.submitAddress(address.text.toString()))
    }

    private fun scan() {
        val options =
            GmsBarcodeScannerOptions
                .Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build()
        GmsBarcodeScanning
            .getClient(this, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                show(model.onScan(barcode.rawValue?.let(ScanResult::Scanned) ?: ScanResult.Failed))
            }.addOnCanceledListener { show(model.onScan(ScanResult.Cancelled)) }
            .addOnFailureListener { e ->
                Log.w(TAG, "The code scanner failed", e)
                show(model.onScan(ScanResult.Failed))
            }
    }

    private fun show(outcome: SetupOutcome) {
        when (outcome) {
            is SetupOutcome.Open -> {
                error.visibility = View.GONE
                // TODO: F4 in feature_list.json - open the board in a Trusted Web Activity
                // through the launcher activity instead of a plain Custom Tab.
                CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(outcome.url))
                finish()
            }

            is SetupOutcome.ShowError -> {
                error.setText(outcome.message)
                error.visibility = View.VISIBLE
            }

            SetupOutcome.Stay -> {
                Unit
            }
        }
    }

    private companion object {
        const val TAG = "SetupActivity"
    }
}
