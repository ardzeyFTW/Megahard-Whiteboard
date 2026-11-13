---
name: verify-whiteboard
description: >-
  Use this skill when validating code, TypeScript types, or frontend bundle
  changes in Megahard Whiteboard on Windows.
---

# Verify Whiteboard

Runs unit tests, TypeScript type checking, and the Vite production build using Windows `.cmd` wrappers.

## Steps

1. Run the unit test suite:
   ```powershell
   npm.cmd test
   ```
2. Run TypeScript typechecking and the Vite production bundle check:
   ```powershell
   npm.cmd run build
   ```
3. Confirm all test files/cases pass and `tsc --noEmit && vite build` exits with code `0` before committing or releasing.
