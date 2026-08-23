import fs from "node:fs";

const [, , file, startStr, endStr, replacementFile] = process.argv;
const start = parseInt(startStr, 10);
const end = parseInt(endStr, 10);

const lines = fs.readFileSync(file, "utf8").split("\n");
const replacement = replacementFile
  ? fs.readFileSync(replacementFile, "utf8").split("\n")
  : [];

if (replacement.length && replacement[replacement.length - 1] === "") {
  replacement.pop();
}

const before = lines.slice(0, start - 1);
const after = lines.slice(end);
const spliced = [...before, ...replacement, ...after];

fs.writeFileSync(file, spliced.join("\n"));
console.log(`Replaced lines ${start}-${end} (${end - start + 1} lines) with ${replacement.length} lines in ${file}`);
