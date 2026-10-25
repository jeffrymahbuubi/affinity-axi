#!/bin/sh
# Check the session-start hook: Report whether the session-start hook is installed, without writing anything
affinity-axi setup hook --file examples/setup-hooks/hooks.json --check
