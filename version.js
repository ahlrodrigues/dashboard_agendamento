const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const PACKAGE_PATH = path.join(__dirname, "package.json");

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
    const version = String(pkg?.version || "").trim();
    return version || "dev";
  } catch (error) {
    return "dev";
  }
}

const VERSION = readVersion();

function getGitCommitShort() {
  try {
    const out = childProcess.execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: __dirname,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return String(out || "").trim();
  } catch (error) {
    return "";
  }
}

function getDashboardVersionLabel() {
  const commit = getGitCommitShort();
  if (!commit) {
    return `V${VERSION}`;
  }
  return `V${VERSION} (${commit})`;
}

module.exports = {
  VERSION,
  getGitCommitShort,
  getDashboardVersionLabel
};

