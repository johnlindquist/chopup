#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const outputFilePath = process.argv[2];

if (!outputFilePath) {
	console.error("Error: Output file path argument missing.");
	process.exit(1);
}

// Ensure the directory for the output file exists
const outputDir = path.dirname(outputFilePath);
if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir, { recursive: true });
}

const writeStream = fs.createWriteStream(outputFilePath);

process.stdin.on("data", (data) => {
	writeStream.write(data);
});

process.stdin.on("end", () => {
	writeStream.end();
});

writeStream.on("error", (err) => {
	console.error("Error writing to output file:", err);
	process.exit(1);
});

// Keep the process alive until stdin is closed or an explicit exit
// For this simple echo, it will exit when stdin is closed by the parent.
