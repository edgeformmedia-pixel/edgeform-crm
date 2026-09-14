# Environment configuration

The Influencer Leads feature reads the OpenAI credential only inside the Cloudflare Worker. Never add a real key to `wrangler.jsonc`, `.dev.vars`, browser code, or source control.

For production, set the encrypted Worker secret:

```sh
npx wrangler secret put OPENAI_API_KEY
```

For local development, add this to the ignored `.dev.vars` file:

```dotenv
OPENAI_API_KEY=your_key_here
```

`OPENAI_MODEL` is a non-secret Worker variable in `wrangler.jsonc` and defaults to `gpt-5.6-terra`. `OPENAI_API_URL` may optionally be set server-side to change the compatible provider base URL; it defaults to `https://api.openai.com/v1`.

Apply the D1 migration before using the page:

```sh
npx wrangler d1 migrations apply edgeform-crm --remote
```

For local development, omit `--remote`.
