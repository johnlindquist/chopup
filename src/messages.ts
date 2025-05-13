export const INSTRUCTIONS_TEMPLATE = `--- Chopup Control ---
To request logs: {execName} request-logs --socket {socketPath}
To send input:   {execName} send-input --socket {socketPath} --input "your text here"
----------------------
`; 