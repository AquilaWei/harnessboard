// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';

/** Must match the phone rules in styles.css, so layout and markup switch at the same width. */
export const PHONE_QUERY = '(max-width: 640px)';

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(PHONE_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** True while the window is phone width; follows rotation and resizing. */
export function usePhoneWidth(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches);
}
