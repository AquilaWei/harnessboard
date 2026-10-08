package io.github.aquilawei.harnessboard.buildlogic;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;

/**
 * The release signing key, read only from environment variables (CI secrets), so no key or
 * password is kept in the repo or read from the user's home.
 */
public final class ReleaseSigning {
    public static final String KEYSTORE = "HB_ANDROID_KEYSTORE";
    public static final String KEYSTORE_PASSWORD = "HB_ANDROID_KEYSTORE_PASSWORD";
    public static final String KEY_ALIAS = "HB_ANDROID_KEY_ALIAS";
    public static final String KEY_PASSWORD = "HB_ANDROID_KEY_PASSWORD";
    private static final List<String> VARIABLES = List.of(KEYSTORE, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD);

    private final byte[] keystore;
    public final String storePassword;
    public final String keyAlias;
    public final String keyPassword;

    private ReleaseSigning(byte[] keystore, String storePassword, String keyAlias, String keyPassword) {
        this.keystore = keystore;
        this.storePassword = storePassword;
        this.keyAlias = keyAlias;
        this.keyPassword = keyPassword;
    }

    /**
     * Reads the four {@code HB_ANDROID_*} variables through {@code env} (null or empty counts as
     * unset, as GitHub passes a missing secret as an empty string). Empty when none is set, so a
     * build without them makes an unsigned release APK.
     *
     * @throws IllegalArgumentException when only some are set (a half-configured CI would
     *     otherwise publish an unsigned APK) or the keystore is not base64; the message names
     *     the variables, never their values
     */
    public static Optional<ReleaseSigning> fromEnvironment(Function<String, String> env) {
        List<String> missing = new ArrayList<>();
        for (String name : VARIABLES) {
            String value = env.apply(name);
            if (value == null || value.isEmpty()) missing.add(name);
        }
        if (missing.size() == VARIABLES.size()) return Optional.empty();
        if (!missing.isEmpty()) {
            throw new IllegalArgumentException(
                    "release signing needs all of " + VARIABLES + "; missing " + missing);
        }
        byte[] keystore;
        try {
            // `base64` wraps its output at 76 columns on Linux, so line breaks are dropped first.
            keystore = Base64.getDecoder().decode(env.apply(KEYSTORE).replaceAll("\\s", ""));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(KEYSTORE + " is not base64", e);
        }
        return Optional.of(
                new ReleaseSigning(keystore, env.apply(KEYSTORE_PASSWORD), env.apply(KEY_ALIAS), env.apply(KEY_PASSWORD)));
    }

    /**
     * Writes the decoded keystore to {@code file} (replacing it), readable only by its owner
     * where the file system supports POSIX permissions, and returns it.
     *
     * @throws IOException when the folder can not be created or the file can not be written
     */
    public File writeKeystore(File file) throws IOException {
        Path path = file.toPath();
        Files.createDirectories(path.getParent());
        Files.deleteIfExists(path);
        Files.createFile(path);
        PosixFileAttributeView posix = Files.getFileAttributeView(path, PosixFileAttributeView.class);
        // Restricted before the key is written, so it is never readable by others.
        if (posix != null) posix.setPermissions(PosixFilePermissions.fromString("rw-------"));
        Files.write(path, keystore);
        return file;
    }
}
