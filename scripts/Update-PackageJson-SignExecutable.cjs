const fs = require("fs");

const file = process.argv[2];

if (!file) {
  console.error("Usage: node Update-PackageJson-SignExecutable.cjs <package.json>");
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(file, "utf8"));
json.build = json.build || {};
json.build.win = json.build.win || {};
json.build.win.signExecutable = true;

fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");