# Release maintenance

The `Release` GitHub Actions workflow publishes `@devsecopslonghn/codex-account-switcher` to the public npm registry with provenance, then attaches the prebuilt tarball and SHA-256 checksum to GitHub Releases. npm publishing uses trusted publishing (GitHub Actions OIDC), not a long-lived npm token. The npm package scope is an npm organization and must be created separately from the GitHub organization. In npm package settings, configure a trusted publisher for GitHub Actions with owner `devsecopslonghn`, repository `codex-account-switcher`, workflow file `release.yml`, and no environment. The first publish and trusted-publisher setup require an npm account with permission to manage that npm organization/package. The workflow also needs `contents: write` to create the GitHub Release. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [GitHub workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

The tarball contains `dist/`, README/docs/systemd templates, package metadata, and bundled `smol-toml`. npm's [`bundleDependencies`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bundledependencies) means consumers do not need build tools. Node/npm and Linux system tools remain prerequisites. Auth files, account caches, local configuration, source tests, and dev dependencies are excluded.

## Publish a new version

Start from a clean checkout with your changes reviewed. Update the version, validate, and commit before tagging:

```sh
npm version patch --no-git-tag-version
npm run check
npm run release:pack
git add package.json package-lock.json
git commit -m "chore: bump release version"
# Use the version now recorded in package.json, for example:
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin main
git push origin v1.0.1
```

Use `minor` or `major` instead of `patch` as appropriate. Tag and `package.json` versions must match exactly. The CLI reads its version from the package metadata, so no source constant needs updating. Current automation supports stable `vX.Y.Z` tags, not prereleases.

A tag push runs install, typecheck/lint/format/tests/build, then `release:pack`. Packaging starts from a clean generated `dist`, verifies package contents and bundled dependencies, installs into a disposable prefix with an **empty npm cache and `--offline --ignore-scripts`**, and exercises the installed CLI. It then writes:

```text
release/devsecopslonghn-codex-account-switcher-X.Y.Z.tgz
release/SHA256SUMS
```

Both directories `dist/` and `release/` are generated and ignored by git. `release:pack` replaces them; do not keep unrelated files there. No packaging step reads the user's Codex credentials or performs a real switch. The workflow is limited to twenty minutes and serializes releases for the same tag.

## Manual run and failure recovery

For an existing tag that does not already have a release, use Actions → Release → Run workflow and enter that tag. Or:

```sh
gh workflow run release.yml --repo devsecopslonghn/codex-account-switcher -f tag=v1.0.1
```

The workflow checks out that tag, not the moving main branch. It verifies the existing tag, publishes to npm, and uses `gh release create` to attach both artifacts and generate notes. Existing npm versions and GitHub releases cannot be overwritten; use a new version for corrections to a published release. If a run stops during GitHub asset upload, inspect whether a draft release was left behind before retrying. Never move an existing release tag to different code.

To check a package locally without publishing:

```sh
npm ci
npm run check
npm run release:pack
(cd release && sha256sum --check SHA256SUMS)
```

Checksums detect corrupted downloads; they are not a separate signing or identity-verification system. Trust comes from authenticated access to the repository and reviewed workflow/tag contents.
