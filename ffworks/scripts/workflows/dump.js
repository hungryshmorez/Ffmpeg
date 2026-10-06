// Dumps the browser app's workflow catalogue (workflows*.js at the repo root) to JSON: node ffworks/scripts/workflows/dump.js > ffworks/docs/browser_workflows.json
const vm = require("vm"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const ctx = { console, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } }, navigator: {}, localStorage: { getItem() { return null; }, setItem() {} }, setTimeout() {}, addEventListener() {} };
ctx.window = ctx; vm.createContext(ctx);
for (const f of ["workflows.js", "workflows_v3.js", "workflows_v4.js", "workflows_v5.js"]) {
  const src = fs.readFileSync(path.join(root, f), "utf8").replace(/^const ([A-Z_0-9]+) *=/gm, "globalThis.$1 =");
  vm.runInContext(src, ctx, { filename: f });
}
const seen = new Map();
for (const [k, v] of Object.entries(ctx)) if (Array.isArray(v) && v.length && v[0] && v[0].id && v[0].name) for (const w of v) if (!seen.has(w.id)) seen.set(w.id, { ...w, _src: k });
process.stdout.write(JSON.stringify([...seen.values()], null, 1) + "\n");
