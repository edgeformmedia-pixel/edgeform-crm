# Environment configuration

The Influencer Leads feature uses the OpenAI credential only inside the Cloudflare Worker. Never add a real key to `wrangler.jsonc`, browser code, or source control.

Owners and admins can enter the OpenAI key from **Find Creators → Settings**. The Worker encrypts that key with AES-GCM before storing it in D1 and never returns it to the browser. The wrapping key is a Worker secret named `AI_SETTINGS_ENCRYPTION_KEY`.

Set the wrapping secret once per Worker environment:

```sh
npx wrangler secret put AI_SETTINGS_ENCRYPTION_KEY
```

Alternatively, set `OPENAI_API_KEY` as a Worker secret to manage the key outside the CRM:

```sh
npx wrangler secret put OPENAI_API_KEY
```

For local development, both secrets can be placed in the ignored `.dev.vars` file. `OPENAI_MODEL` is a non-secret Worker variable in `wrangler.jsonc` and defaults to `gpt-5.6-terra`. `OPENAI_API_URL` may optionally be set server-side to change the compatible provider base URL; it defaults to `https://api.openai.com/v1`.

Apply the D1 migration before using the page:

```sh
npx wrangler d1 migrations apply edgeform-crm --remote
```

For local development, omit `--remote`.
