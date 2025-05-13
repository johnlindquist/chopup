process.stdout.write("Interactive script started. Send me input!\n");
process.stdin.on("data", (data) => {
	const input = data.toString().trim();
	process.stdout.write(`RECEIVED: ${input}\n`);
	if (input === "exit") {
		process.stdout.write("Exiting script.\n");
		process.exit(0);
	}
});
