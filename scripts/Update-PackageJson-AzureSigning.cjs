const fs = require("fs");

const file = process.argv[2];

if (!file) {
  console.error("Usage: node Update-PackageJson-AzureSigning.cjs <package.json>");
  process.exit(1);
}

const configText = process.env.ROOMCAST_AZURE_SIGNING_CONFIG || "";
if (!configText) {
  console.error("ROOMCAST_AZURE_SIGNING_CONFIG is not set");
  process.exit(1);
}

const config = JSON.parse(configText);
const json = JSON.parse(fs.readFileSync(file, "utf8"));

json.build = json.build || {};
json.build.win = json.build.win || {};
json.build.win.signExecutable = true;
json.build.win.azureSignOptions = config;

fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");