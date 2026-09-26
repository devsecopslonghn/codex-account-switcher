# Release maintenance

The `Release` GitHub Actions workflow publishes a prebuilt npm tarball and SHA-256 checksum file to GitHub Releases in this private repository. It does not publish to the npm registry or require a personal access token: the job's scoped `GITHUB_TOKEN` has `contents: write`. Downloads still require repository access. Workflow syntax and permission details are documented by [GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

The tarball contains `dist/`, README/docs/systemd templates, package metadata, and bundled `smol-toml`. npm's [`bundleDependencies`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bundledependencies) makes this a single-file offline installation; Node/npm and Linux system tools remain prerequisites. Auth files, account caches, local configuration, source tests, and dev dependencies are excluded.

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
release/codex-account-switcher-X.Y.Z.tgz
release/SHA256SUMS
```

Both directories `dist/` and `release/` are generated and ignored by git. `release:pack` replaces them; do not keep unrelated files there. No packaging step reads the user's Codex credentials or performs a real switch. The workflow is limited to twenty minutes and serializes releases for the same tag.

## Manual run and failure recovery

For an existing tag that does not already have a release, use Actions → Release → Run workflow and enter that tag. Or:

```sh
gh workflow run release.yml --repo longhn0710/codex-account-switcher -f tag=v1.0.1
```

The workflow checks out that tag, not the moving main branch. It verifies the existing tag and uses `gh release create` to attach both artifacts and generate notes. Existing releases fail explicitly; published package bytes are never silently overwritten. If a run stops during upload, inspect whether a draft release was left behind before retrying. Repair/remove an incomplete draft only after reviewing it; use a new version for corrections to a published release. Never move an existing release tag to different code.

To check a package locally without publishing:

```sh
npm ci
npm run check
npm run release:pack
(cd release && sha256sum --check SHA256SUMS)
```

Checksums detect corrupted downloads; they are not a separate signing or identity-verification system. Trust comes from authenticated access to the repository and reviewed workflow/tag contents.
