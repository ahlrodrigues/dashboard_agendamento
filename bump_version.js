const fs = require("fs");
const path = require("path");

const PACKAGE_PATH = path.join(__dirname, "package.json");
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function readPackageJson() {
  const raw = fs.readFileSync(PACKAGE_PATH, "utf8");
  const data = JSON.parse(raw);
  return { raw, data };
}

function writePackageJson(data) {
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function bump(version, kind) {
  const match = String(version || "").trim().match(VERSION_PATTERN);
  if (!match) {
    throw new Error(`Versao invalida em package.json: ${version}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (kind === "patch") {
    patch += 1;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else {
    throw new Error(`Tipo invalido: ${kind}`);
  }

  return `${major}.${minor}.${patch}`;
}

function main() {
  const kind = process.argv[2];
  if (!["patch", "minor", "major"].includes(kind)) {
    console.error("Uso: node bump_version.js patch|minor|major");
    process.exitCode = 1;
    return;
  }

  const { data } = readPackageJson();
  const currentVersion = data.version;
  const nextVersion = bump(currentVersion, kind);
  data.version = nextVersion;
  writePackageJson(data);
  process.stdout.write(`${nextVersion}\n`);
}

main();

