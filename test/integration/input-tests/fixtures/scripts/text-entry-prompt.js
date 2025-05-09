#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const outputFile = process.argv[2];

if (!outputFile) {
	console.error("Error: Output file path argument missing.");
	process.exit(1);
}

console.error(`Started. Output file: ${outputFile}`);

const outputDir = path.dirname(outputFile);
if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir, { recursive: true });
}

const writeStream = fs.createWriteStream(outputFile);
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

let handled = false;
const finish = (answer) => {
	if (handled) return;
	handled = true;
	fs.writeFile(outputFile, `Name entered: ${answer}\n`, (err) => {
		if (err) {
			console.error(`Error writing to output file: ${err.message}`);
			process.exit(1);
		} else {
			process.exit(0);
		}
	});
};

rl.on("line", (line) => {
	finish(line);
});

setTimeout(() => {
	if (!handled) finish("");
}, 1000);
