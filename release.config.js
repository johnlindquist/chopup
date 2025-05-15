module.exports = {
	branches: ["main"],
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		[
			"@semantic-release/release-notes-generator",
			{ preset: "conventionalcommits" },
		],
		["@semantic-release/npm", { npmPublish: true }],
		[
			"@semantic-release/git",
			{
				assets: ["package.json"],
				message:
					"chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
	],
	verbose: true,
};
