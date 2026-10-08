package io.github.aquilawei.harnessboard

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.Signature
import android.content.pm.SigningInfo
import androidx.browser.trusted.Token
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadow.api.Shadow

@RunWith(RobolectricTestRunner::class)
class PreferencesTokenStoreTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    @Before
    fun installBrowser() {
        // Token.create reads the browser's signing certificate.
        val signingInfo = Shadow.newInstanceOf(SigningInfo::class.java)
        shadowOf(signingInfo).setSignatures(arrayOf(Signature("0123456789abcdef")))
        shadowOf(context.packageManager).installPackage(
            PackageInfo().apply {
                packageName = BROWSER
                this.signingInfo = signingInfo
            },
        )
    }

    @Test
    fun `a fresh install has no browser token`() {
        assertNull(PreferencesTokenStore(context).load())
    }

    // Token.matches needs IPackageManager.hasSigningCertificate, which Robolectric lacks, so the
    // token is compared by its serialized form.
    @Test
    fun `a stored browser token is read back by a new store`() {
        val token = Token.create(BROWSER, context.packageManager)!!
        PreferencesTokenStore(context).store(token)

        assertArrayEquals(token.serialize(), PreferencesTokenStore(context).load()?.serialize())
    }

    @Test
    fun `storing no token clears the stored one`() {
        val store = PreferencesTokenStore(context)
        store.store(Token.create(BROWSER, context.packageManager))

        store.store(null)

        assertNull(PreferencesTokenStore(context).load())
    }

    private companion object {
        const val BROWSER = "com.example.browser"
    }
}
