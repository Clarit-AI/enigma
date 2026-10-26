# FAQ

**Why is my `enigma` command suddenly a symlink?** Because a marketplace install has no `postinstall` to run, so the plugin creates one link in a directory already on your `PATH` during your first session after installing. It refuses to replace an `enigma` that already works, repairs only a broken one left by a plugin upgrade, and never edits your shell config. `enigma doctor` shows the current state; `ENIGMA_NO_PATH_SHIM=1` turns it off. See [install.md](install.md).

**Does the agent ever see my secret's value?** On any path Enigma controls, no: no MCP tool result carries one, and `npm run leak-fence` fails the build if the storage layer's `resolve()` function is ever reachable from `src/mcp/**` or `src/web/**`. That is a statement about Enigma's own code, not a promise about the agent's behaviour. An agent that deliberately goes looking for a value in its own environment is out of scope by design. See the limits at the end of [Proof](../README.md#proof) in the README and [`SECURITY.md`](SECURITY.md).

**What if I want to see the value myself?** Call `enigma_reveal` (or `/enigma:reveal NAME`). It opens a one-time page or copies to your clipboard, and it is human-initiated only; the agent shouldn't invoke it on its own judgment.

**Can I use this for CI or a cron job?** Yes. Pick a `none`-prompt-profile depository (`env` or `encrypted`) and pass `usage: "unattended"` to `enigma_request` when you store the value. A `may-prompt` or `prompts-each-read` depository will hang the job.

**What happens if I read a `.env` file by accident?** The read-guard denies it before the content ever reaches the session, and tells you (or the agent) to use `enigma_request` or `enigma run` instead.

**Does remote access mean anyone with the link can see my secret?** The request/reveal link carries only a random, single-use, time-limited id, and a `cloudflared`/`tailscale serve` tunnel's lifetime is tied to that one request. It is still a bearer link with no PIN in v1. See the tunnel-interception section of [`SECURITY.md`](SECURITY.md) for the exact boundary.

**Why not just use 1Password/the Keychain directly?** You can, and Enigma stores into them rather than replacing them (`1password` and `keychain` are two of the five depositories). What Enigma adds is the handoff: getting a value from that store into a running command without an agent (or you) ever typing it into a chat window.
