# yapsnipe

Checks every 2-character username (a-z and 0-9, so 1296 names) on yapper.website
and writes the free ones to `available.txt`. It needs Node 18 or newer and nothing else.

## 1. Node

Install Node from https://nodejs.org (the LTS version), then run:

    node -v

You need v18 or higher.

## 2. Log in (paste into curl.txt)

You don't need to edit `config.json`.

1. Log in to Yapper in Chrome or Edge and press F12. Open the **Network** tab.
2. Click around Yapper so requests appear. Right-click any request to
   `api.yapper.website` (e.g. `profiles?...`) and choose
   **Copy > Copy as cURL (cmd)**. The bash version works too.
3. Open `curl.txt` in this folder with Notepad, paste, and save.

The tool reads your login from that file. The login inside it expires after
about an hour. When the tool says "not logged in", repeat these steps and run
`scan` again; it resumes where it stopped.

`curl.txt` logs in as you, so don't share it.

## 3. Check the lookup works

`config.json` already looks names up in Yapper's `profiles` table, which the web
app reads when it shows a profile:

    https://api.yapper.website/rest/v1/profiles?select=username&username=ilike.{name}

An empty `[]` reply means no profile has that name. This is inferred from the web
app's own requests, not confirmed, so check it before a full scan:

    node snipe.js test YOUR_OWN_USERNAME     should say TAKEN
    node snipe.js test qzxqzxqzxqzx          should say FREE

If both say FREE, the table probably hides rows you aren't allowed to see. In that
case use the username-check request from the settings screen instead (below).
If your own name returns more than one row, usernames aren't unique on Yapper
(there is a `discriminator` field) and "free" means less than it sounds.

### Alternative: the settings-screen check

If the profiles lookup doesn't work, find the request the app makes when you
change your username:

1. Keep DevTools open on the Network tab (Fetch/XHR), and clear it (the 🚫 icon).
2. In Yapper, go to the settings screen where you **change your username**.
3. Type a name slowly in the box. Look for a new row with `username`, `check`,
   `available` or `handle` in its name. It is probably one of these:
   - an **RPC**: `.../rest/v1/rpc/SOMETHING` (a POST). Click it and open the
     **Payload** tab to see the body, e.g. `{"p_username":"zq"}`.
   - a **table lookup**: `.../rest/v1/profiles?select=...&username=eq.zq` (a GET).
4. Put it in `config.json`:

   For an RPC, set `checkUrl` to the URL, `"method": "POST"`, and copy the
   payload into `body`, replacing the name you typed with `{name}`:

       "checkUrl": "https://api.yapper.website/rest/v1/rpc/check_username",
       "method": "POST",
       "body": { "p_username": "{name}" },

   For a table lookup, put the whole URL in `checkUrl` with `{name}` in place of
   the name, set `"method": "GET"`, and delete the `body` line. An empty `[]`
   reply then counts as free.

(`check_username` and `p_username` above are examples. Use whatever your browser shows.)

If the settings screen only checks when you press Save, pick a name you're sure
is taken (like your own) so nothing actually changes.

## 4. Run it

Open a terminal in this folder and run:

    node snipe.js list              (shows the 1296 candidates, no network)
    node snipe.js test ab           (checks one name and shows the raw reply)
    node snipe.js scan --limit 20   (small trial run)
    node snipe.js scan              (full run)

Run `test` first. It should print `verdict: FREE` or `verdict: TAKEN`. If it says
`UNKNOWN`, paste the output to whoever is helping you so the parser can be adjusted.

`scan` checks every 2 and 3 character name (a-z and 0-9 in any mix), shortest
first, one name per request:

    2 chars: 1296    3 chars: 46656    (47952 total)

At the defaults (3 at a time, 300 ms pause) that is roughly 5 to 7 names a second:
2 characters take a few minutes and 3 characters about 2 hours. Your login
expires every hour or so, so the run stops each time until you paste a fresh one
into `curl.txt`. Free names are written to `available.txt` as the scan goes. Press Ctrl+C at any point and run `scan` again later to pick
up where it stopped. Use `--fresh` to start over.

Other options:

    --max 3                              stop after 3 characters
    --len 2                              only 2 characters
    --chars abcdefghijklmnopqrstuvwxyz   letters only
    --concurrency 2 --delay 1000         go slower if you get rate limited

## Output

- `available.txt`: one free name per line
- `state.json`: progress, so a run can resume

## Caveats

- Yapper's terms forbid "selfbots", and automating your own account like this is
  exactly that. They could rate limit or ban the account. Use a throwaway
  account if that worries you, and keep the speed low.
- "Free" means only that the check endpoint said so. Some names may still be
  reserved and get rejected when you try to claim them.
- Each account can hold only one username.
