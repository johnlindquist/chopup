// test/integration/input-tests/fixtures/scripts/stdin-echo.js
process.stdin.on("data", (data) => {
	console.log(`ECHOED: ${data.toString().trim()}`);
});

process.stdin.on("end", () => {
	console.log("stdin-echo.js stdin ended.");
});

console.log("stdin-echo.js ready for input");

process.on("SIGTERM", () => {
	console.log("stdin-echo.js received SIGTERM");
	process.exit(0);
});
process.on("SIGINT", () => {
	console.log("stdin-echo.js received SIGINT");
	process.exit(0);
});
