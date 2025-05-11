#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const outputFilePath = process.argv[2];

if (!outputFilePath) {
	console.error("Error: yes-no-prompt.js - Output file path argument missing.");
	process.exit(1);
}

// Ensure the directory for the output file exists
const outputDir = path.dirname(outputFilePath);
if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir, { recursive: true });
}

console.log("[YES_NO_PROMPT] Script started. Output file:", outputFilePath);
const writeStream = fs.createWriteStream(outputFilePath);
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout, // Prompt will go to actual stdout, not the file
});

rl.question("Confirm? (y/n): ", (answer) => {
	const sanitizedAnswer = answer.trim().toLowerCase();
	let response;
	if (sanitizedAnswer === "y") {
		response = "Confirmed: yes";
	} else if (sanitizedAnswer === "n") {
		response = "Confirmed: no";
	} else {
		response = `Invalid input: ${answer}`;
	}
	console.log("[YES_NO_PROMPT] Received input:", answer);
	writeStream.write(`${response}\n`);
	writeStream.end(() => {
		console.log("[YES_NO_PROMPT] Exiting. Wrote response:", response);
		rl.close();
		process.exit(0);
	});
});
