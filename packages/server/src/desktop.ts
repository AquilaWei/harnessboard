// SPDX-License-Identifier: Apache-2.0
// Entry the desktop app starts in Electron's utility process. It takes no arguments:
// Commander reads Electron's argv differently from Node's, so `cli.js serve` would fail there.
import { loadConfig } from '@harnessboard/core';
import { runServer } from './run.js';

await runServer(loadConfig());
