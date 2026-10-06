#!/usr/bin/env node
import { run } from "./program.js";

const code = await run(process.argv.slice(2));
process.exitCode = code;
// Normally the process ends on its own here. If something still holds it
// open (e.g. a model request abandoned at its time limit), end it anyway.
// The timer is unref'd, so it never delays an exit that would happen anyway.
setTimeout(() => process.exit(code), 100).unref();
