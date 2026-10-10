package io.github.aquilawei.harnessboard

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button

/**
 * Shown instead of the browser's error page when the board does not answer. **Retry** and
 * **Open anyway** go back through [LauncherActivity] with the same URL; **Change board** forgets
 * the saved board and shows setup.
 */
class UnreachableActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_unreachable)
        val url = intent.getStringExtra(EXTRA_URL)
        findViewById<Button>(R.id.retry).setOnClickListener { relaunch(url, skipCheck = false) }
        findViewById<Button>(R.id.open_anyway).setOnClickListener { relaunch(url, skipCheck = true) }
        findViewById<Button>(R.id.change_board).setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java).setAction(SetupModel.ACTION_CHANGE_BOARD))
            finish()
        }
    }

    private fun relaunch(
        url: String?,
        skipCheck: Boolean,
    ) {
        startActivity(
            Intent(this, LauncherActivity::class.java)
                .putExtra(LauncherActivity.EXTRA_PENDING_URL, url)
                .putExtra(LauncherActivity.EXTRA_SKIP_CHECK, skipCheck),
        )
        finish()
    }

    companion object {
        /** The URL the launcher was about to open; handed back on Retry so a pairing code is not lost. */
        const val EXTRA_URL = "io.github.aquilawei.harnessboard.UNREACHABLE_URL"
    }
}
