#!/usr/bin/env node
let count = 0;
const prefix = process.argv[2] ? `${process.argv[2]} ` : ""; // Get prefix from arg

const interval = setInterval(() => {
	const timestamp = new Date().toISOString();
	console.log(`${prefix}${timestamp} - Line ${count}`); // Use prefix
	count++;
	if (count > 100) {
		// Stop after a while to prevent infinite loops in tests
		clearInterval(interval);
	}
}, 100); // Print every 100ms

// Ensure we clean up if we receive termination signals
process.on("SIGTERM", () => {
	console.log("continuous-output.js received SIGTERM");
	clearInterval(interval);
	process.exit(0);
});

process.on("SIGINT", () => {
	console.log("continuous-output.js received SIGINT");
	clearInterval(interval);
	process.exit(0);
});

// Log startup for debugging
console.log(`${prefix}continuous-output.js started with PID ${process.pid}`); // Use prefix
