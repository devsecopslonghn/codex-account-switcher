import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  writeFile,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.name, "codex-account-switcher");
if (process.env.RELEASE_TAG) {
  assert.equal(
    process.env.RELEASE_TAG,
    `v${manifest.version}`,
    "Tag must match package.json version",
  );
}
assert.deepEqual(
  manifest.bundleDependencies,
  Object.keys(manifest.dependencies),
);
const output = path.join(root, "release");
await rm(output, { recursive: true, force: true });
await mkdir(output);
// Always package a clean build; stale dist files must not enter the release.
await rm(path.join(root, "dist"), { recursive: true, force: true });
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", output], {
    cwd: root,
    encoding: "utf8",
  }),
);
const filename = `${manifest.name}-${manifest.version}.tgz`;
assert.equal(packed.filename, filename);
assert.deepEqual(
  packed.bundled.sort(),
  manifest.bundleDependencies.slice().sort(),
);
for (const file of packed.files) {
  assert.match(
    file.path,
    /^(?:package\.json|README\.md|docs\/[\w.-]+\.md|systemd\/[\w.-]+\.(?:service|timer)|dist\/[\w./-]+\.(?:js|d\.ts)|node_modules\/smol-toml\/[\w./-]+)$/,
  );
}
assert.ok(packed.files.some((f) => f.path === "dist/cli.js"));
assert.ok(
  packed.files.some((f) => f.path === "node_modules/smol-toml/package.json"),
);

// Empty npm cache + --offline proves consumers need no registry or build tool.
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "codex-account-release-"),
);
try {
  const prefix = path.join(temporary, "install");
  execFileSync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--cache",
      path.join(temporary, "empty-cache"),
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(output, filename),
    ],
    { cwd: temporary, stdio: "inherit" },
  );
  const bin = path.join(prefix, "bin", "codex-account");
  assert.ok(
    (await stat(bin)).mode & 0o111,
    "Installed command must be executable",
  );
  assert.equal(
    execFileSync(process.execPath, [bin, "--version"], {
      encoding: "utf8",
    }).trim(),
    manifest.version,
  );
  assert.match(
    execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" }),
    /sync-all/,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const digest = createHash("sha256")
  .update(await readFile(path.join(output, filename)))
  .digest("hex");
await writeFile(path.join(output, "SHA256SUMS"), `${digest}  ${filename}\n`);
process.stdout.write(
  `Ready: release/${filename} and release/SHA256SUMS (offline installation verified)\n`,
);
