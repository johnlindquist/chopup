let count = 0;
process.stdout.write("Long running script started. Logging periodically.\n");
const interval = setInterval(() => {
	count++;
	process.stdout.write(`Log entry ${count} at ${new Date().toISOString()}\n`);
	if (count >= 10) {
		process.stdout.write("Long running script finished.\n");
		clearInterval(interval);
		process.exit(0);
	}
}, 1000);
