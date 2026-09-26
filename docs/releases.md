# Release maintenance

The `Release` GitHub Actions workflow publishes `@devsecopslonghn/codex-account-switcher` to npm with provenance, then attaches the tarball and checksum to GitHub Releases. Publishing uses npm Trusted Publishing via GitHub OIDC, so no npm token is stored in GitHub. Follow these steps once to set it up.

### 1. Create the npm account and organization

Sign up at [npmjs.com](https://www.npmjs.com/signup), verify the account, and enable two-factor authentication. Then sign in, open your profile menu, choose **Add an Organization**, and create the npm organization `devsecopslonghn`. Select **Unlimited public packages** (the free plan). This npm organization is separate from the GitHub organization with the same name. npm requires a user account before creating an organization, and organization-scoped packages use the organization's name as their scope. See npm's [organization setup guide](https://docs.npmjs.com/creating-an-organization/) and [scoped public package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

Before publishing, choose a license for public users if you intend to grant them permission to use the code. The manifest currently says `UNLICENSED`; publishing that package does not grant an open-source license.

### 2. Bootstrap the first npm version

This repository's first npm version, `1.0.1`, has already been published and verified. Do not repeat the bootstrap or publish `1.0.1` again. For a new package/scope in the future, npm must have a package record before its package settings can be used to add a Trusted Publisher. On a maintainer machine with Node 24, clone the repo and publish that package's initial version once:

```sh
git clone https://github.com/devsecopslonghn/codex-account-switcher.git
cd codex-account-switcher
npm login
npm run check
npm run release:pack
npm publish --access public
```

Do not push a Git tag for an initial version published manually: npm does not allow publishing the same version twice.

### 3. Add npm's Trusted Publisher

Open `@devsecopslonghn/codex-account-switcher` on npmjs.com, then **Package settings → Trusted Publisher → Add a publisher → GitHub Actions**. Enter:

| npm setting          | Value                       |
| -------------------- | --------------------------- |
| Organization or user | `devsecopslonghn`           |
| Repository           | `codex-account-switcher`    |
| Workflow filename    | `release.yml`               |
| Environment          | Leave blank                 |
| Allowed action       | Enable direct `npm publish` |

The filename is just `release.yml`, not `.github/workflows/release.yml`. Choose direct `npm publish`; newer npm publisher configurations may default to staged publishing, which this workflow does not use. Trusted publishing requires npm CLI 11.5.1+ and Node 22.14+; the workflow uses Node 24. Read npm's [Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/) for the current UI and requirements.

### 4. Check the GitHub organization settings

The repository is already under `devsecopslonghn`, and its workflow already declares `id-token: write` for npm OIDC and `contents: write` for creating GitHub Releases. In GitHub organization **Settings → Actions → General**, make sure Actions are allowed to run for this repository. **No organization Actions variable or secret is needed for npm publishing**: do not create `NPM_TOKEN`. The workflow exchanges its short-lived OIDC identity with npm. GitHub's automatically provided `GITHUB_TOKEN` is used for the Release upload.

### 5. Publish subsequent versions from a Git tag

After `1.0.1` exists and the Trusted Publisher is configured, publish the next version through Actions. For example:

```sh
npm version patch --no-git-tag-version
npm run check
git add package.json package-lock.json
git commit -m "chore: bump release version"
git tag -a v1.0.2 -m "Release v1.0.2"
git push origin main
git push origin v1.0.2
```

The tag must match `package.json` exactly. GitHub Actions then tests, builds, publishes to npm, and creates the corresponding GitHub Release. Consumers can install it with `npm install --global @devsecopslonghn/codex-account-switcher`.

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
git tag -a v1.0.2 -m "Release v1.0.2"
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
gh workflow run release.yml --repo devsecopslonghn/codex-account-switcher -f tag=v1.0.2
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
