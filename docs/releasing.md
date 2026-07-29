# Releasing packages

Each workspace under `packages/` is published independently to the public npm
registry under the `@cyon` scope. The repository root remains private and is
not published.

## One-time npm setup

The first release requires an npm account with permission to publish public
packages under `@cyon`.

1. Sign in locally with `npm login`.
2. Confirm the account with `npm whoami`.
3. Run the repository checks and tarball dry run.
4. Publish each package once from its workspace directory.

Example:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run release:dry-run

cd packages/pi-memory
npm publish --access public
```

Repeat the final command for the other five workspaces.

## Trusted Publishing

After a package exists on npm, configure its npm Trusted Publisher:

- Provider: GitHub Actions
- Organization or user: `simplecyon`
- Repository: `pi-packages`
- Workflow: `publish-package.yml`
- Environment: `npm`

Configure all six packages. The workflow uses GitHub OIDC and does not require a
long-lived `NPM_TOKEN`.

## Publishing a new version

1. Update the selected workspace's `version` in `package.json`.
2. Update its README or changelog when behavior changed.
3. Run:

   ```bash
   pnpm install --lockfile-only
   pnpm run check
   pnpm run release:dry-run
   ```

4. Commit and push the version change.
5. In GitHub Actions, run **Publish npm package** and select the workspace.

The workflow refuses to publish a version that is already present on npm.

## Package names

| Workspace | npm package |
| --- | --- |
| `pi-minimal-tui` | `@cyon/pi-minimal-tui` |
| `pi-memory` | `@cyon/pi-memory` |
| `pi-context-compact` | `@cyon/pi-context-compact` |
| `pi-context-inspector` | `@cyon/pi-context-inspector` |
| `pi-session-tasks` | `@cyon/pi-session-tasks` |
| `pi-skill-telemetry` | `@cyon/pi-skill-telemetry` |
