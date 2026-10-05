const [cmd, flag, branch] = process.argv.slice(2);
console.log(`fake typetorch ${cmd} ${flag} ${branch} in ${process.cwd()}`);
console.log(`api key passed to deploy: ${Boolean(process.env.OPENCLOUD_API_KEY || process.env.TYPETORCH_API_KEY || process.env.ROBLOX_API_KEY)}`);
console.log(`exchange secret visible to deploy: ${Boolean(process.env.TYPETORCH_REMOTE_CLAUDE_SECRET)}`);
console.log("deployed artifact dev-1234abc");
