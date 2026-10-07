package io.github.aquilawei.harnessboard.buildlogic;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Turns the server package's version into the Android {@code versionCode}. */
public final class VersionCode {
    private static final Pattern VERSION = Pattern.compile("(\\d+)\\.(\\d+)\\.(\\d+)");

    private VersionCode() {}

    /**
     * MAJOR*10000 + MINOR*100 + PATCH, so each release has a higher code than the one before.
     *
     * @throws IllegalArgumentException for anything but MAJOR.MINOR.PATCH (a pre-release suffix
     *     included) or a MINOR/PATCH of 100 or more, which this formula can not order
     */
    public static int of(String version) {
        Matcher m = VERSION.matcher(version);
        if (!m.matches()) {
            throw new IllegalArgumentException("version '" + version + "' is not MAJOR.MINOR.PATCH");
        }
        int major = Integer.parseInt(m.group(1));
        int minor = Integer.parseInt(m.group(2));
        int patch = Integer.parseInt(m.group(3));
        if (minor >= 100 || patch >= 100) {
            throw new IllegalArgumentException("version '" + version + "': MINOR and PATCH must be below 100");
        }
        return major * 10000 + minor * 100 + patch;
    }
}
