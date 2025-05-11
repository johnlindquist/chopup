#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const outputFile = process.argv[2];

if (!outputFile) {
	console.error("Error: Output file path argument missing.");
	process.exit(1);
}

console.log("[TEXT_ENTRY_PROMPT] Script started. Output file:", outputFile);
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
	console.log("[TEXT_ENTRY_PROMPT] Received input:", answer);
	fs.writeFile(outputFile, `Name entered: ${answer}\n`, (err) => {
		if (err) {
			console.error(`Error writing to output file: ${err.message}`);
			process.exit(1);
		} else {
			console.log(
				"[TEXT_ENTRY_PROMPT] Exiting. Wrote response:",
				`Name entered: ${answer}`,
			);
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
