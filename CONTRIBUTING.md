# Contributing

1. Initialize a local virtual environment and install `requirements-dev.txt`.
2. Install frontend dependencies with `pnpm install --frozen-lockfile`.
3. Make focused changes and add tests for observable behavior.
4. Run `pnpm check` before opening a pull request.
5. Never commit signing keys, generated sidecars, diagnostics, tokens, or user data.

Generated protocol and TypeScript files must be refreshed with `pnpm generate` whenever their
sources change. Application versions must be updated with `python scripts/sync_version.py --set X.Y.Z`.
