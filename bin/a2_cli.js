#!/usr/bin/env node

import { runA2Cli } from '../a2_cli.mjs'

runA2Cli(process.argv.slice(2)).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
