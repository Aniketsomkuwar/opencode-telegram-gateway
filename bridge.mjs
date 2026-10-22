#!/usr/bin/env node
/**
 * Compatibility shim. The gateway is TypeScript now; build it with `npm run build`
 * and this file just forwards to dist/index.js so existing scheduled tasks and
 * `node bridge.mjs` invocations keep working.
 */
import './dist/index.js';
