# Deploy FROSH on Render

This guide deploys the complete FROSH service as two Render web services plus a
managed PostgreSQL database:

- **FROSH API** — Bun API, device gateway, external/mobile API, migrations, and tools
- **FROSH Control Center** — Next.js web UI plus a loopback-only Bun API sidecar
  for authenticated console requests and Google OAuth
- **PostgreSQL** — durable conversations, tasks, preferences, approvals, and encrypted Google credentials

The loopback API sidecar keeps Control Center requests inside one free Render
container. This is important because free Render web services can send private
network traffic but cannot receive it, and routing authenticated console traffic
through a second service's public edge can produce intermittent gateway errors.

A static-site host alone is not suitable: FROSH needs a long-running API,
WebSocket support, server-side OAuth exchange, and persistent storage.

## Before beginning

- The `arena/4c8e3401-javis` branch is pushed to GitHub.
- You control DNS for `geekyacedigitalhub.com`.
- Google Cloud has a Web OAuth client whose redirect URI is exactly:

  ```text
  https://frosh.geekyacedigitalhub.com/api/google/callback
  ```

- Keep the replacement Google client secret private. Do not upload the Google
  JSON file to GitHub or paste secrets into chat.

## 1. Create the database

1. In Render, create a **PostgreSQL** database called `frosh-postgres` in a
   region close to the two services.
2. After it is available, copy its **internal connection string** for use by
   the FROSH API service. Render keeps this value inside its dashboard.

## 2. Create the FROSH API service

1. In Render, choose **New → Web Service** and connect
   `Geekyacedigitalhub/javis`.
2. Select branch `arena/4c8e3401-javis`.
3. Choose the **Docker** runtime.
4. Set the Dockerfile path to:

   ```text
   Dockerfile.api
   ```

   Use the repository root as the Docker build context.
5. Set health check path to:

   ```text
   /health
   ```

6. Add these environment variables in Render. Generate the random values on
   your own computer or with Render's secret generator; use the same
   `FROSH_WEB_TOKEN` value later in the web service.

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | Render PostgreSQL internal connection string |
   | `FROSH_WEB_TOKEN` | a long random secret shared only with the web service |
   | `FROSH_DEVICE_ENROLLMENT_TOKEN` | a separate long random secret |
   | `FROSH_USER_ID` | `default-user` initially |
   | `FROSH_AUTOMATION_USER_ID` | `default-user` initially |
   | `GOOGLE_CLIENT_ID` | the new Google OAuth client ID |
   | `GOOGLE_CLIENT_SECRET` | the new Google OAuth client secret |
   | `FROSH_GOOGLE_REDIRECT_URI` | `https://frosh.geekyacedigitalhub.com/api/google/callback` |
   | `FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY` | exactly 32 random bytes encoded as base64 |
   | `OPENAI_API_KEY` | optional; omit to use the offline provider until configured |

   To generate an encryption key locally, run:

   ```bash
   openssl rand -base64 32
   ```

   Do not change `FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY` after people connect
   Google accounts; changing it makes previously encrypted credentials
   intentionally unreadable and requires reconnection.

7. Deploy the service and confirm its `/health` endpoint returns JSON with
   `"ok": true`. Keep its Render HTTPS URL for direct health checks and mobile
   clients. The Control Center below runs its authenticated API sidecar locally,
   so it does not use this public URL for server-to-server console requests.

The API image automatically runs the checksum-protected migration runner before
starting. If migration fails, correct the database URL rather than bypassing it.

## 3. Create the FROSH Control Center service

1. Create another **Web Service** from the same repository and branch.
2. Choose the **Docker** runtime.
3. Set Dockerfile path:

   ```text
   Dockerfile.web
   ```

   Again, use repository root as its build context.
4. Add these environment variables. The Control Center image starts a
   loopback-only API sidecar on port 3001, so it needs the same **server-only**
   API variables as `frosh-api` to run migrations, authenticate console calls,
   and handle Google OAuth. Copy values privately in Render; never paste them
   into chat or commit them to Git.

   | Key | Value |
   | --- | --- |
   | `FROSH_API_URL` | `http://127.0.0.1:3001` |
   | `DATABASE_URL` | the same Render PostgreSQL internal connection string used by `frosh-api` |
   | `FROSH_WEB_TOKEN` | the exact same value configured on the API service |
   | `FROSH_DEVICE_ENROLLMENT_TOKEN` | the same API value, if device enrollment is enabled |
   | `FROSH_USER_ID` | `default-user` initially |
   | `GOOGLE_CLIENT_ID` | the same API Google OAuth client ID |
   | `GOOGLE_CLIENT_SECRET` | the same API Google OAuth client secret |
   | `FROSH_GOOGLE_REDIRECT_URI` | `https://frosh.geekyacedigitalhub.com/api/google/callback` |
   | `FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY` | the exact same API token-encryption key |
   | `FROSH_PUBLIC_APP_URL` | `https://frosh.geekyacedigitalhub.com` |
   | `OPENAI_API_KEY` | optional; copy it only if configured on `frosh-api` and chat should use it |

   Also copy any other optional provider/tool variables that you deliberately
   configured on `frosh-api`. Do **not** set `FROSH_WEB_AUTH_DISABLED` in a
   production service. Do not use any `NEXT_PUBLIC_` variable for a token,
   client secret, database URL, or encryption key.

   On Render's free instances, an inactive service can take 50 seconds or more
   to wake. The colocated sidecar avoids a second free web service's public edge
   for authenticated Control Center requests.

5. Deploy it and confirm the Render-provided URL opens. The initial browser
   Basic Auth prompt accepts any username and the `FROSH_WEB_TOKEN` as the
   password. This is the existing control-center authentication boundary.

## 4. Point the FROSH domain at Render

1. In the Control Center service, add this custom domain in Render:

   ```text
   frosh.geekyacedigitalhub.com
   ```

2. Render will show the exact DNS target it expects. In the DNS provider for
   `geekyacedigitalhub.com`, add a **CNAME** record:

   | Host / name | Target |
   | --- | --- |
   | `frosh` | the exact Render target shown in the dashboard |

3. Wait for Render to verify DNS and provision HTTPS. Do not invent an A record
   or substitute another host: use the target Render gives you.
4. Open:

   ```text
   https://frosh.geekyacedigitalhub.com
   ```

## 5. Connect Google

Once the custom domain has valid HTTPS and both services are healthy:

1. Open **Integrations** in the FROSH Control Center.
2. Select **Connect Google**.
3. Sign in with the Google account already listed as an OAuth test user.
4. Review the Calendar-events and Gmail-read-only consent request and allow it.
5. Return to Integrations and confirm it shows **Connected**.

FROSH stores the OAuth credential encrypted server-side. Calendar reads and
Gmail unread summaries can run after connection; Calendar event creation still
requires explicit approval in FROSH Approval Center.

## Production checklist

- [ ] `https://frosh.geekyacedigitalhub.com` has a valid HTTPS certificate
- [ ] API `/health` returns `ok: true`
- [ ] API uses a managed PostgreSQL `DATABASE_URL`, not in-memory storage
- [ ] Web and API share the same strong `FROSH_WEB_TOKEN`
- [ ] Google client secret and encryption key exist only in the API service's secret variables
- [ ] OAuth redirect URI exactly matches Google Cloud and the live domain
- [ ] OAuth app stays in **Testing** with the intended Google account as test user
- [ ] Exposed/replaced Google OAuth clients have been deleted or rotated
