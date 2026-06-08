@echo off
setlocal EnableExtensions
setlocal EnableDelayedExpansion

set scriptdir=%~dp0

call node %scriptdir%\generate-provider-test.js %~1
call node %scriptdir%\..\run-against-dist.mjs npx jest "./provider-tests/providers/%~1"
