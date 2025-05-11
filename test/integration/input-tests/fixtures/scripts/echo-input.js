#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const outputFilePath = process.argv[2];

if (!outputFilePath) {
	console.error("Error: Output file path argument missing.");
	process.exit(1);
}

console.log("[ECHO_INPUT] Script started. Output file:", outputFilePath);
// Ensure the directory for the output file exists
const outputDir = path.dirname(outputFilePath);
if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir, { recursive: true });
}

const writeStream = fs.createWriteStream(outputFilePath);

process.stdin.on("data", (data) => {
	console.log("[ECHO_INPUT] Received input:", data.toString());
	writeStream.write(data);
});

process.stdin.on("end", () => {
	writeStream.end(() => {
		console.log("[ECHO_INPUT] Exiting. Wrote input to file.");
	});
});

writeStream.on("error", (err) => {
	console.error("Error writing to output file:", err);
	process.exit(1);
});

// Keep the process alive until stdin is closed or an explicit exit
// For this simple echo, it will exit when stdin is closed by the parent.
