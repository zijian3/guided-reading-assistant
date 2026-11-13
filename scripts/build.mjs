import {build} from "esbuild";
import {mkdir, copyFile, readFile} from "node:fs/promises";
await mkdir("dist", {recursive:true});
const license = await readFile("LICENSE", "utf8");
await build({entryPoints:["src/main.js"], outfile:"dist/main.js", bundle:true, platform:"node", format:"cjs", target:"es2022", external:["obsidian","electron"], sourcemap:false, minify:false, banner:{js:`/*! Guided Reading Assistant\n${license}\n*/`}});
for (const name of ["manifest.json","styles.css","LICENSE","NOTICE.md"]) await copyFile(name, `dist/${name}`);
console.log("Built dist/main.js, manifest.json, styles.css");
