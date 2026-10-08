package io.github.aquilawei.harnessboard.buildlogic;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class VersionCodeTest {
    @Test
    public void oneTwoThreeBecomes10203() {
        assertEquals(10203, VersionCode.of("1.2.3"));
    }

    @Test
    public void zeroZeroTwentyThreeBecomes23() {
        assertEquals(23, VersionCode.of("0.0.23"));
    }

    @Test
    public void largestMinorAndPatchBecome9999() {
        assertEquals(9999, VersionCode.of("0.99.99"));
    }

    @Test
    public void minorOf100IsRejected() {
        assertThrows(IllegalArgumentException.class, () -> VersionCode.of("1.100.0"));
    }

    @Test
    public void patchOf100IsRejected() {
        assertThrows(IllegalArgumentException.class, () -> VersionCode.of("1.0.100"));
    }

    @Test
    public void preReleaseSuffixIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> VersionCode.of("1.2.3-beta.1"));
    }
}
