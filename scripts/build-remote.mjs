import { cpSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const release = process.argv.includes("--release");

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    process.stderr.write(`Could not run ${command}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function requireArtifact(path, label) {
  try {
    const artifact = statSync(path);
    if (artifact.isFile() && artifact.size > 0) return;
  } catch {}
  process.stderr.write(`${label} is missing or empty: ${path}\n`);
  process.exit(1);
}

// The remote agent targets Linux servers. Cross-compile with e.g.
// TERAX_REMOTE_TARGET=x86_64-unknown-linux-musl (needs rustup target add).
const target =
  process.env.TERAX_REMOTE_TARGET?.trim() || "x86_64-unknown-linux-gnu";
const cargoArgs = [
  "build",
  "--locked",
  "--manifest-path",
  join(tauriDir, "Cargo.toml"),
  "--package",
  "terax-remote",
  "--bin",
  "terax-remote",
  "--target",
  target,
];
if (release) cargoArgs.push("--release");

run("cargo", cargoArgs);

const profile = release ? "release" : "debug";
const source = join(
  tauriDir,
  "target",
  target,
  profile,
  "terax-remote",
);
const destination = join(
  tauriDir,
  "binaries",
  `terax-remote-${target}`,
);
requireArtifact(source, "Built remote agent artifact");
mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination);
chmodSync(destination, 0o755);
requireArtifact(destination, "Prepared remote agent");

console.log(`Prepared ${destination.slice(root.length + 1)}`);
