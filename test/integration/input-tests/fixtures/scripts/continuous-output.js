let count = 0;
const interval = setInterval(() => {
	const timestamp = new Date().toISOString();
	console.log(`${timestamp} - Line ${count}`);
	count++;
	if (count > 100) {
		// Stop after a while to prevent infinite loops in tests
		clearInterval(interval);
	}
}, 100); // Print every 100ms

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
