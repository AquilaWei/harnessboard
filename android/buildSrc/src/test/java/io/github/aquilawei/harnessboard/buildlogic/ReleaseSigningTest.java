package io.github.aquilawei.harnessboard.buildlogic;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assume.assumeTrue;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Map;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ReleaseSigningTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();

    // "AQID" is base64 for the bytes 1, 2, 3.
    private static final Map<String, String> ALL_SET =
            Map.of(
                    "HB_ANDROID_KEYSTORE", "AQID",
                    "HB_ANDROID_KEYSTORE_PASSWORD", "store-pass",
                    "HB_ANDROID_KEY_ALIAS", "harnessboard",
                    "HB_ANDROID_KEY_PASSWORD", "key-pass");

    @Test
    public void noVariablesMeansUnsigned() {
        assertFalse(ReleaseSigning.fromEnvironment(Map.<String, String>of()::get).isPresent());
    }

    @Test
    public void emptyVariablesMeanUnsigned() {
        Map<String, String> env =
                Map.of(
                        "HB_ANDROID_KEYSTORE", "",
                        "HB_ANDROID_KEYSTORE_PASSWORD", "",
                        "HB_ANDROID_KEY_ALIAS", "",
                        "HB_ANDROID_KEY_PASSWORD", "");
        assertFalse(ReleaseSigning.fromEnvironment(env::get).isPresent());
    }

    @Test
    public void allVariablesGiveTheAliasAndPasswords() {
        ReleaseSigning signing = ReleaseSigning.fromEnvironment(ALL_SET::get).orElseThrow();
        assertEquals("store-pass", signing.storePassword);
        assertEquals("harnessboard", signing.keyAlias);
        assertEquals("key-pass", signing.keyPassword);
    }

    @Test
    public void aMissingVariableIsNamedInTheError() {
        Map<String, String> env =
                Map.of(
                        "HB_ANDROID_KEYSTORE", "AQID",
                        "HB_ANDROID_KEYSTORE_PASSWORD", "store-pass",
                        "HB_ANDROID_KEY_ALIAS", "harnessboard");
        IllegalArgumentException e =
                assertThrows(IllegalArgumentException.class, () -> ReleaseSigning.fromEnvironment(env::get));
        assertEquals(
                "release signing needs all of [HB_ANDROID_KEYSTORE, HB_ANDROID_KEYSTORE_PASSWORD, "
                        + "HB_ANDROID_KEY_ALIAS, HB_ANDROID_KEY_PASSWORD]; missing [HB_ANDROID_KEY_PASSWORD]",
                e.getMessage());
    }

    @Test
    public void aKeystoreThatIsNotBase64IsRejected() {
        Map<String, String> env =
                Map.of(
                        "HB_ANDROID_KEYSTORE", "not base64!",
                        "HB_ANDROID_KEYSTORE_PASSWORD", "store-pass",
                        "HB_ANDROID_KEY_ALIAS", "harnessboard",
                        "HB_ANDROID_KEY_PASSWORD", "key-pass");
        IllegalArgumentException e =
                assertThrows(IllegalArgumentException.class, () -> ReleaseSigning.fromEnvironment(env::get));
        assertEquals("HB_ANDROID_KEYSTORE is not base64", e.getMessage());
    }

    @Test
    public void writeKeystoreWritesTheDecodedBytes() throws Exception {
        File file = new File(temp.getRoot(), "signing/release.jks");
        ReleaseSigning.fromEnvironment(ALL_SET::get).orElseThrow().writeKeystore(file);
        assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(file.toPath()));
    }

    @Test
    public void wrappedBase64IsDecoded() throws Exception {
        Map<String, String> env =
                Map.of(
                        "HB_ANDROID_KEYSTORE", "AQ\nID\n",
                        "HB_ANDROID_KEYSTORE_PASSWORD", "store-pass",
                        "HB_ANDROID_KEY_ALIAS", "harnessboard",
                        "HB_ANDROID_KEY_PASSWORD", "key-pass");
        File file = new File(temp.getRoot(), "release.jks");
        ReleaseSigning.fromEnvironment(env::get).orElseThrow().writeKeystore(file);
        assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(file.toPath()));
    }

    @Test
    public void writeKeystoreReplacesAnOldFile() throws Exception {
        File file = temp.newFile("release.jks");
        Files.write(file.toPath(), new byte[] {9, 9, 9, 9});
        ReleaseSigning.fromEnvironment(ALL_SET::get).orElseThrow().writeKeystore(file);
        assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(file.toPath()));
    }

    @Test
    public void writtenKeystoreIsReadableOnlyByItsOwner() throws Exception {
        File file = new File(temp.getRoot(), "release.jks");
        ReleaseSigning.fromEnvironment(ALL_SET::get).orElseThrow().writeKeystore(file);
        PosixFileAttributeView posix = Files.getFileAttributeView(file.toPath(), PosixFileAttributeView.class);
        assumeTrue("POSIX permissions only", posix != null);
        assertEquals(
                PosixFilePermissions.fromString("rw-------"), posix.readAttributes().permissions());
    }
}
