// Assembles the static playground in site/ from the compiled TypeScript (dist/) and the examples.
// GitHub Pages publishes this folder; `npm start` serves it locally.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const site = root + "site/";

rmSync(site, { recursive: true, force: true });
mkdirSync(site + "examples", { recursive: true });

for (const file of ["index.html", "style.css", "favicon.svg"]) {
  cpSync(root + "web/" + file, site + file);
}
// Only the browser needs these two folders; source maps point at .ts files the site doesn't ship.
const scripts = (src) => !src.endsWith(".map");
cpSync(root + "dist/src", site + "js/src", { recursive: true, filter: scripts });
cpSync(root + "dist/web", site + "js/web", { recursive: true, filter: scripts });

// Each example's first line is a comment with its title.
const examples = readdirSync(root + "examples")
  .filter((f) => f.endsWith(".fern"))
  .sort()
  .map((file) => {
    const code = readFileSync(root + "examples/" + file, "utf8");
    cpSync(root + "examples/" + file, site + "examples/" + file);
    return { file, title: code.split("\n")[0].replace(/^\/\/\s*/, "") };
  });
writeFileSync(site + "examples/index.json", JSON.stringify(examples, null, 2));

console.log(`Built site/ with ${examples.length} examples`);
